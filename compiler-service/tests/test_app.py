from __future__ import annotations

import base64
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

import app  # noqa: E402


TOKEN = "deterministic-test-token-000000000000000000000000"
SOURCE = "void setup() {}\nvoid loop() {}\n"
VALID_HEX = ":020000000C945E\n:00000001FF\n"


def event_for(
    payload: object | None = None,
    *,
    token: str | None = TOKEN,
    method: str = "POST",
    content_type: str = "application/json",
    raw_body: str | None = None,
    base64_encoded: bool = False,
) -> dict[str, object]:
    headers: dict[str, str] = {"content-type": content_type}
    if token is not None:
        headers["X-Firelight-Compiler-Token"] = token
    if raw_body is None:
        raw_body = json.dumps(
            payload
            if payload is not None
            else {"fqbn": app.ALLOWED_FQBN, "source": SOURCE}
        )
    if base64_encoded:
        raw_body = base64.b64encode(raw_body.encode()).decode()
    return {
        "version": "2.0",
        "requestContext": {"http": {"method": method}},
        "headers": headers,
        "body": raw_body,
        "isBase64Encoded": base64_encoded,
    }


def artifact_for(source: str = SOURCE, hex_text: str = VALID_HEX) -> app.CompileArtifact:
    return app.CompileArtifact(
        fqbn=app.ALLOWED_FQBN,
        source_hash=hashlib.sha256(source.encode()).hexdigest(),
        artifact_hash=hashlib.sha256(hex_text.encode()).hexdigest(),
        hex_text=hex_text,
    )


def response_json(response: dict[str, object]) -> dict[str, object]:
    return json.loads(str(response["body"]))


class HandlerTests(unittest.TestCase):
    def handle(self, event: object, compile_fn=None):
        return app.handle_event(
            event,
            token_loader=lambda: TOKEN,
            compile_fn=compile_fn or (lambda source: artifact_for(source)),
        )

    def test_success_contract_hashes_and_security_headers(self):
        response = self.handle(event_for())
        payload = response_json(response)

        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(
            payload,
            {
                "ok": True,
                "artifact": {
                    "artifactHash": hashlib.sha256(VALID_HEX.encode()).hexdigest(),
                    "format": "intel-hex",
                    "fqbn": app.ALLOWED_FQBN,
                    "hex": VALID_HEX,
                    "sourceHash": hashlib.sha256(SOURCE.encode()).hexdigest(),
                },
                "diagnostics": [],
            },
        )
        headers = response["headers"]
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        self.assertNotIn("access-control-allow-origin", headers)
        self.assertNotIn("compileJobId", str(response["body"]))

    def test_missing_and_wrong_tokens_have_identical_responses(self):
        missing = self.handle(event_for(token=None))
        wrong = self.handle(event_for(token="x" * 48))
        self.assertEqual(missing, wrong)
        self.assertEqual(missing["statusCode"], 401)
        self.assertEqual(response_json(missing)["error"]["code"], "COMPILER_UNAUTHORIZED")

    def test_secret_loader_failure_is_generic(self):
        def fail():
            raise RuntimeError("secret https://internal.invalid/private")

        response = app.handle_event(event_for(), token_loader=fail)
        self.assertEqual(response["statusCode"], 503)
        self.assertNotIn("internal.invalid", str(response["body"]))
        self.assertEqual(
            response_json(response)["error"]["code"], "COMPILER_UNAVAILABLE"
        )

    def test_authentication_happens_before_method_validation(self):
        unauthenticated = self.handle(event_for(token=None, method="GET"))
        authenticated = self.handle(event_for(method="GET"))
        self.assertEqual(unauthenticated["statusCode"], 401)
        self.assertEqual(authenticated["statusCode"], 405)
        self.assertEqual(authenticated["headers"]["allow"], "POST")

    def test_rejects_non_json_media_type(self):
        response = self.handle(event_for(content_type="text/plain"))
        self.assertEqual(response["statusCode"], 415)
        self.assertEqual(
            response_json(response)["error"]["code"],
            "COMPILER_UNSUPPORTED_MEDIA_TYPE",
        )

    def test_accepts_json_content_type_with_charset(self):
        response = self.handle(event_for(content_type="Application/JSON; charset=utf-8"))
        self.assertEqual(response["statusCode"], 200)

    def test_rejects_unknown_or_missing_fields(self):
        unknown = self.handle(
            event_for({"fqbn": app.ALLOWED_FQBN, "source": SOURCE, "jobId": "no"})
        )
        missing = self.handle(event_for({"fqbn": app.ALLOWED_FQBN}))
        self.assertEqual(unknown["statusCode"], 400)
        self.assertEqual(missing["statusCode"], 400)

    def test_rejects_duplicate_json_keys(self):
        raw_body = (
            '{"fqbn":"arduino:avr:nano:cpu=atmega328old",'
            '"source":"first","source":"second"}'
        )
        response = self.handle(event_for(raw_body=raw_body))
        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(
            response_json(response)["error"]["code"], "COMPILER_INVALID_REQUEST"
        )

    def test_rejects_every_other_board_target(self):
        for fqbn in ("arduino:avr:nano:cpu=atmega328", "arduino:avr:nanó"):
            with self.subTest(fqbn=fqbn):
                response = self.handle(event_for({"fqbn": fqbn, "source": SOURCE}))
                self.assertEqual(response["statusCode"], 422)
                self.assertEqual(
                    response_json(response)["error"]["code"],
                    "COMPILER_UNSUPPORTED_TARGET",
                )

    def test_source_limit_is_utf8_bytes_and_exact_limit_is_accepted(self):
        exact_source = "é" * (app.MAX_SOURCE_BYTES // 2)
        exact = self.handle(
            event_for({"fqbn": app.ALLOWED_FQBN, "source": exact_source})
        )
        oversized = self.handle(
            event_for({"fqbn": app.ALLOWED_FQBN, "source": exact_source + "a"})
        )
        self.assertEqual(exact["statusCode"], 200)
        self.assertEqual(oversized["statusCode"], 413)
        self.assertEqual(
            response_json(oversized)["error"]["code"], "COMPILER_SOURCE_TOO_LARGE"
        )

    def test_rejects_empty_and_nul_source(self):
        for source in ("", "void setup() {}\x00"):
            with self.subTest(source=source):
                response = self.handle(
                    event_for({"fqbn": app.ALLOWED_FQBN, "source": source})
                )
                self.assertEqual(response["statusCode"], 400)

    def test_rejects_unpaired_unicode_surrogate(self):
        raw_body = (
            '{"fqbn":"arduino:avr:nano:cpu=atmega328old",'
            '"source":"\\ud800"}'
        )
        response = self.handle(event_for(raw_body=raw_body))
        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(
            response_json(response)["error"]["code"], "COMPILER_INVALID_REQUEST"
        )

    def test_request_body_limit_precedes_json_parse(self):
        response = self.handle(event_for(raw_body="x" * (app.MAX_REQUEST_BYTES + 1)))
        self.assertEqual(response["statusCode"], 413)
        self.assertEqual(
            response_json(response)["error"]["code"], "COMPILER_REQUEST_TOO_LARGE"
        )

    def test_base64_function_url_body(self):
        encoded = self.handle(event_for(base64_encoded=True))
        invalid = self.handle(event_for(raw_body="not base64!", base64_encoded=True))
        self.assertEqual(encoded["statusCode"], 200)
        self.assertEqual(invalid["statusCode"], 400)

    def test_compile_diagnostics_redact_token_url_path_and_source_lines(self):
        def fail(_: str):
            raise app.CompilerError(
                "compile_failed",
                status=422,
                diagnostics=(
                    f"/tmp/firelight/private.ino:1: error: {TOKEN} at https://secret.invalid/a",
                    "/usr/local/private/tool:2: note: internal location",
                    "this source line must not be returned",
                ),
            )

        response = self.handle(event_for(), compile_fn=fail)
        body = str(response["body"])
        self.assertEqual(response["statusCode"], 422)
        self.assertNotIn(TOKEN, body)
        self.assertNotIn("secret.invalid", body)
        self.assertNotIn("/tmp/", body)
        self.assertNotIn("/usr/local", body)
        self.assertNotIn("source line", body)
        self.assertIn("[redacted]", body)
        self.assertIn("[redacted-url]", body)
        self.assertEqual(len(response_json(response)["diagnostics"]), 2)

    def test_unexpected_compiler_exception_never_leaks_details(self):
        def fail(_: str):
            raise RuntimeError(f"{TOKEN} https://private.invalid /tmp/private")

        response = self.handle(event_for(), compile_fn=fail)
        body = str(response["body"])
        self.assertEqual(response["statusCode"], 500)
        self.assertEqual(
            response_json(response)["error"]["code"], "COMPILER_INTERNAL_ERROR"
        )
        self.assertNotIn(TOKEN, body)
        self.assertNotIn("private.invalid", body)

    def test_oversized_result_fails_closed(self):
        huge_hex = "x" * app.MAX_RESULT_BYTES
        response = self.handle(
            event_for(), compile_fn=lambda _: artifact_for(hex_text=huge_hex)
        )
        self.assertEqual(response["statusCode"], 500)
        self.assertEqual(
            response_json(response)["error"]["code"], "COMPILER_INTERNAL_ERROR"
        )


class CompilerTests(unittest.TestCase):
    def test_compile_uses_pinned_target_deadline_scrubbed_env_and_plain_hex(self):
        observed = {}

        def runner(command, **kwargs):
            observed["command"] = command
            observed.update(kwargs)
            output_dir = Path(command[command.index("--output-dir") + 1])
            (output_dir / "FirelightSketch.ino.hex").write_text(
                VALID_HEX.replace("\n", "\r\n"), encoding="ascii"
            )
            (output_dir / "FirelightSketch.ino.with_bootloader.hex").write_text(
                VALID_HEX, encoding="ascii"
            )
            return app.ProcessResult(0, b"success", b"")

        artifact = app.compile_sketch(SOURCE, runner=runner)
        command = observed["command"]
        self.assertEqual(command[command.index("--fqbn") + 1], app.ALLOWED_FQBN)
        self.assertEqual(command[command.index("--jobs") + 1], "1")
        self.assertEqual(observed["timeout_seconds"], 45.0)
        self.assertEqual(observed["max_output_bytes"], 64 * 1024)
        self.assertEqual(artifact.hex_text, VALID_HEX)
        self.assertEqual(artifact.source_hash, hashlib.sha256(SOURCE.encode()).hexdigest())
        self.assertEqual(artifact.artifact_hash, hashlib.sha256(VALID_HEX.encode()).hexdigest())
        self.assertNotIn("AWS_REGION", observed["env"])
        self.assertNotIn("FIRELIGHT_COMPILER_SECRET_ARN", observed["env"])

    def test_compile_failure_only_keeps_sanitized_severity_lines(self):
        def runner(command, **_):
            root = command[-1]
            return app.ProcessResult(
                1,
                b"source code line\n",
                f"{root}/x.ino:4: error: no match at https://example.invalid/x\n".encode(),
            )

        with self.assertRaises(app.CompilerError) as caught:
            app.compile_sketch(SOURCE, runner=runner)
        self.assertEqual(caught.exception.code, "compile_failed")
        rendered = "\n".join(caught.exception.diagnostics)
        self.assertNotIn("/tmp/", rendered)
        self.assertNotIn("example.invalid", rendered)
        self.assertNotIn("source code", rendered)

    def test_compile_timeout_is_a_stable_error(self):
        def runner(*_, **__):
            return app.ProcessResult(-9, b"", b"", timed_out=True)

        with self.assertRaises(app.CompilerError) as caught:
            app.compile_sketch(SOURCE, runner=runner)
        self.assertEqual(caught.exception.code, "compile_timeout")
        self.assertEqual(caught.exception.status, 504)

    def test_missing_or_multiple_plain_hex_artifacts_fail_closed(self):
        def no_hex(*_, **__):
            return app.ProcessResult(0, b"", b"")

        with self.assertRaises(app.CompilerError) as missing:
            app.compile_sketch(SOURCE, runner=no_hex)
        self.assertEqual(missing.exception.code, "artifact_invalid")

        def multiple(command, **_):
            output_dir = Path(command[command.index("--output-dir") + 1])
            (output_dir / "a.hex").write_text(VALID_HEX, encoding="ascii")
            (output_dir / "b.hex").write_text(VALID_HEX, encoding="ascii")
            return app.ProcessResult(0, b"", b"")

        with self.assertRaises(app.CompilerError) as duplicated:
            app.compile_sketch(SOURCE, runner=multiple)
        self.assertEqual(duplicated.exception.code, "artifact_invalid")

    def test_compiler_process_output_is_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            result = app._run_bounded(
                [sys.executable, "-c", "import os; os.write(1, b'x' * 10000)"],
                cwd=Path(directory),
                timeout_seconds=2,
                max_output_bytes=32,
                env={"PATH": "/usr/bin:/bin"},
            )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(result.stdout) + len(result.stderr), 32)
        self.assertTrue(result.output_truncated)

    def test_compiler_process_deadline_kills_process_group(self):
        with tempfile.TemporaryDirectory() as directory:
            started = app.time.monotonic()
            result = app._run_bounded(
                [sys.executable, "-c", "import time; time.sleep(5)"],
                cwd=Path(directory),
                timeout_seconds=0.05,
                max_output_bytes=32,
                env={"PATH": "/usr/bin:/bin"},
            )
            elapsed = app.time.monotonic() - started
        self.assertTrue(result.timed_out)
        self.assertLess(elapsed, 2)


class IntelHexTests(unittest.TestCase):
    def test_valid_hex_returns_unique_payload_size(self):
        self.assertEqual(app._validate_intel_hex(VALID_HEX), 2)

    def test_rejects_bad_checksum_missing_eof_and_empty_payload(self):
        invalid_values = (
            ":020000000C945F\n:00000001FF\n",
            ":020000000C945E\n",
            ":00000001FF\n",
            ":020000000c945e\n:00000001ff\n",
        )
        for value in invalid_values:
            with self.subTest(value=value), self.assertRaises(app.CompilerError):
                app._validate_intel_hex(value)

    def test_rejects_overlapping_flash_records(self):
        # Both data records write addresses 0 and 1; each record checksum is valid.
        overlapping = ":020000000C945E\n:020000000C945E\n:00000001FF\n"
        with self.assertRaises(app.CompilerError) as caught:
            app._validate_intel_hex(overlapping)
        self.assertEqual(caught.exception.code, "artifact_invalid")

    def test_rejects_data_at_or_above_application_flash_ceiling(self):
        # Extended linear address 0, then one byte at 0x7800 (30,720).
        too_high = ":020000040000FA\n:017800000087\n:00000001FF\n"
        with self.assertRaises(app.CompilerError) as caught:
            app._validate_intel_hex(too_high)
        self.assertEqual(caught.exception.code, "artifact_too_large")


class TokenTests(unittest.TestCase):
    def test_token_validation_rejects_short_long_and_whitespace(self):
        for token in ("short", "x" * 513, "x" * 32 + "\n", "x" * 32 + "\ninside"):
            with self.subTest(token_length=len(token)), self.assertRaises(RuntimeError):
                app._validate_service_token(token)

    def test_hash_then_constant_time_auth_requires_nonempty_exact_value(self):
        self.assertTrue(app._authenticate(TOKEN, TOKEN))
        self.assertFalse(app._authenticate("", TOKEN))
        self.assertFalse(app._authenticate(TOKEN + "x", TOKEN))


if __name__ == "__main__":
    unittest.main()
