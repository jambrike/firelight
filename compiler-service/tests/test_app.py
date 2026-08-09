from __future__ import annotations

import base64
import hashlib
import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

import app  # noqa: E402


TOKEN = "deterministic-test-token-000000000000000000000000"
SOURCE = "void setup() {}\nvoid loop() {}\n"
VALID_HEX = ":020000000C945E\n:00000001FF\n"
BUILD_ID = "a" * 40
IMAGE_DIGEST = f"sha256:{'b' * 64}"
RELEASE_IDENTITY = app.ReleaseIdentity(
    environment="staging",
    service_name="firelight-compiler-stg",
    build_id=BUILD_ID,
    image_digest=IMAGE_DIGEST,
)


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
            identity_loader=lambda: RELEASE_IDENTITY,
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
                "identity": RELEASE_IDENTITY.public_payload(),
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

    def test_authenticated_get_exposes_only_bound_release_identity(self):
        unauthenticated = self.handle(event_for(token=None, method="GET"))
        authenticated = self.handle(event_for(method="GET"))
        self.assertEqual(unauthenticated["statusCode"], 401)
        self.assertNotIn("identity", response_json(unauthenticated))
        self.assertEqual(authenticated["statusCode"], 200)
        self.assertEqual(
            response_json(authenticated),
            {"identity": RELEASE_IDENTITY.public_payload(), "ok": True},
        )

    def test_every_authenticated_error_with_loaded_identity_carries_exact_identity(self):
        cases = (
            event_for(method="DELETE"),
            event_for(content_type="text/plain"),
            event_for({"fqbn": "arduino:avr:uno", "source": SOURCE}),
        )
        for event in cases:
            with self.subTest(event=event):
                response = self.handle(event)
                self.assertGreaterEqual(response["statusCode"], 400)
                self.assertEqual(
                    response_json(response)["identity"],
                    RELEASE_IDENTITY.public_payload(),
                )

    def test_invalid_release_identity_fails_only_after_authentication(self):
        identity_loader = mock.Mock(side_effect=RuntimeError("bad identity"))
        unauthorized = app.handle_event(
            event_for(token=None),
            token_loader=lambda: TOKEN,
            identity_loader=identity_loader,
        )
        self.assertEqual(unauthorized["statusCode"], 401)
        identity_loader.assert_not_called()

        authenticated = app.handle_event(
            event_for(),
            token_loader=lambda: TOKEN,
            identity_loader=identity_loader,
        )
        self.assertEqual(authenticated["statusCode"], 503)
        self.assertEqual(
            response_json(authenticated)["error"]["code"],
            "COMPILER_UNAVAILABLE",
        )

    def test_release_identity_configuration_is_exact_and_canonical(self):
        values = {
            "FIRELIGHT_COMPILER_ENVIRONMENT": "production",
            "FIRELIGHT_COMPILER_SERVICE_NAME": "firelight-compiler-prd",
            "FIRELIGHT_COMPILER_BUILD_ID": BUILD_ID,
            "FIRELIGHT_COMPILER_IMAGE_DIGEST": IMAGE_DIGEST,
        }
        self.assertEqual(
            app._load_release_identity(values).public_payload(),
            {
                "buildId": BUILD_ID,
                "environment": "production",
                "imageDigest": IMAGE_DIGEST,
                "protocolVersion": 1,
                "serviceName": "firelight-compiler-prd",
            },
        )
        for name, value in [
            ("FIRELIGHT_COMPILER_ENVIRONMENT", "development"),
            ("FIRELIGHT_COMPILER_SERVICE_NAME", "firelight-compiler-stg"),
            ("FIRELIGHT_COMPILER_BUILD_ID", "A" * 40),
            ("FIRELIGHT_COMPILER_BUILD_ID", "0" * 40),
            ("FIRELIGHT_COMPILER_IMAGE_DIGEST", f"sha256:{'0' * 64}"),
        ]:
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                app._load_release_identity({**values, name: value})

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

    def test_rejects_compiler_file_and_inline_assembly_features_before_compile(self):
        rejected = (
            'asm(".incbin \\"/proc/1/environ\\"");',
            '#include "/etc/passwd"',
            "#pragma GCC poison setup",
            'const char *path = "../private";',
            '__attribute__((section(".text"))) int value;',
            "%:include <Servo.h>",
            "??=include <Servo.h>",
            'a\\\nsm(".inc\\\nbin \\"/pr\\\noc/1/environ\\"");',
            'a\\\rsm(".incbin \\"/proc/1/environ\\"");',
            "/**/ %:include <Servo.h>",
            "/**/ #include </etc/passwd>",
            'const char *fake = R"(asm(".incbin /proc/1/environ"))";',
        )
        compile_fn = mock.Mock(return_value=artifact_for())

        for source in rejected:
            with self.subTest(source=source):
                response = self.handle(
                    event_for({"fqbn": app.ALLOWED_FQBN, "source": source}),
                    compile_fn=compile_fn,
                )
                self.assertEqual(response["statusCode"], 422)
                self.assertEqual(
                    response_json(response)["error"]["code"],
                    "COMPILER_SOURCE_POLICY_REJECTED",
                )
        compile_fn.assert_not_called()

    def test_allows_only_the_repository_servo_include(self):
        source = "#include <Servo.h>\nvoid setup() {}\nvoid loop() {}\n"
        response = self.handle(
            event_for({"fqbn": app.ALLOWED_FQBN, "source": source}),
            compile_fn=lambda candidate: artifact_for(candidate),
        )
        self.assertEqual(response["statusCode"], 200)

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

    def test_diagnostics_reject_source_text_that_merely_contains_a_severity_word(self):
        diagnostics = app._safe_diagnostics(
            'const char *leaked = "error: learner source";\n'
            "/tmp/firelight/x.ino:4:2: error: expected expression",
            redactions=("/tmp/firelight",),
        )

        self.assertEqual(diagnostics, ("[redacted][path]:4:2: error: expected expression",))
        self.assertNotIn("learner source", "\n".join(diagnostics))

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
        self.assertEqual(
            response_json(response)["identity"],
            RELEASE_IDENTITY.public_payload(),
        )


class IsolationBoundaryTests(unittest.TestCase):
    def test_public_lambda_authenticates_before_forwarding(self):
        forward = mock.Mock(return_value=artifact_for())
        with (
            mock.patch.object(app, "_load_service_token", return_value=TOKEN),
            mock.patch.object(
                app,
                "_load_release_identity",
                return_value=RELEASE_IDENTITY,
            ),
            mock.patch.object(app, "_invoke_isolated_compiler", forward),
        ):
            accepted = app.gateway_lambda_handler(event_for(), None)
            rejected = app.gateway_lambda_handler(event_for(token=None), None)

        self.assertEqual(accepted["statusCode"], 200)
        self.assertEqual(rejected["statusCode"], 401)
        forward.assert_called_once_with(SOURCE)

    def test_lambda_handler_alias_can_never_select_local_compile(self):
        self.assertIs(app.lambda_handler, app.gateway_lambda_handler)

    def test_internal_handler_has_no_application_auth_or_secret_dependency(self):
        event = event_for(token=None)
        response = app.isolated_handle_event(
            event,
            compile_fn=lambda source: artifact_for(source),
        )

        self.assertEqual(response["statusCode"], 200)
        self.assertNotIn("unauthorized", str(response).lower())

    def test_internal_alb_url_is_strictly_pinned(self):
        valid = "http://internal-firelight-123.eu-west-1.elb.amazonaws.com/compile"
        self.assertEqual(app._validate_internal_compiler_url(valid), valid)

        invalid = (
            "https://internal-firelight-123.eu-west-1.elb.amazonaws.com/compile",
            "http://internal-firelight-123.eu-west-1.elb.amazonaws.com:8080/compile",
            "http://internal-firelight-123.eu-west-1.elb.amazonaws.com/other",
            "http://internal-firelight-123.eu-west-1.elb.amazonaws.com/compile?next=x",
            "http://internal-firelight-123.us-east-1.elb.amazonaws.com/compile",
            "http://example.com/compile",
            "http://user@internal-firelight-123.eu-west-1.elb.amazonaws.com/compile",
        )
        for candidate in invalid:
            with self.subTest(candidate=candidate), self.assertRaises(RuntimeError):
                app._validate_internal_compiler_url(candidate)

    def test_gateway_revalidates_internal_artifact_and_source_binding(self):
        payload = {
            "artifact": {
                "artifactHash": hashlib.sha256(VALID_HEX.encode()).hexdigest(),
                "format": app.ARTIFACT_FORMAT,
                "fqbn": app.ALLOWED_FQBN,
                "hex": VALID_HEX,
                "sourceHash": hashlib.sha256(SOURCE.encode()).hexdigest(),
            },
            "diagnostics": [],
            "ok": True,
        }
        raw = json.dumps(payload).encode()

        artifact = app._artifact_from_internal_response(
            200,
            raw,
            expected_source=SOURCE,
        )
        self.assertEqual(artifact.hex_text, VALID_HEX)

        payload["artifact"]["sourceHash"] = "0" * 64
        with self.assertRaises(app.CompilerError) as caught:
            app._artifact_from_internal_response(
                200,
                json.dumps(payload).encode(),
                expected_source=SOURCE,
            )
        self.assertEqual(caught.exception.code, "compiler_unavailable")

    def test_gateway_rejects_oversized_or_status_inconsistent_internal_results(self):
        with self.assertRaises(app.CompilerError) as oversized:
            app._artifact_from_internal_response(
                200,
                b"x" * (app.MAX_RESULT_BYTES + 1),
                expected_source=SOURCE,
            )
        self.assertEqual(oversized.exception.code, "compiler_unavailable")

        body = json.dumps(
            {
                "diagnostics": [],
                "error": {
                    "code": "COMPILER_TIMEOUT",
                    "message": "ignored",
                },
                "ok": False,
            }
        ).encode()
        with self.assertRaises(app.CompilerError) as inconsistent:
            app._artifact_from_internal_response(
                422,
                body,
                expected_source=SOURCE,
            )
        self.assertEqual(inconsistent.exception.code, "compiler_unavailable")

    def test_service_mode_must_be_explicit(self):
        with self.assertRaises(SystemExit):
            app.main([])

    def test_internal_http_surface_bounds_requests_and_results(self):
        server = app._BoundedThreadingHTTPServer(
            ("127.0.0.1", 0), app._CompilerRequestHandler
        )
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        host, port = server.server_address
        response = app._json_response(
            200,
            {
                "artifact": {
                    "artifactHash": hashlib.sha256(VALID_HEX.encode()).hexdigest(),
                    "format": app.ARTIFACT_FORMAT,
                    "fqbn": app.ALLOWED_FQBN,
                    "hex": VALID_HEX,
                    "sourceHash": hashlib.sha256(SOURCE.encode()).hexdigest(),
                },
                "diagnostics": [],
                "ok": True,
            },
        )
        try:
            with mock.patch.object(app, "isolated_handle_event", return_value=response):
                connection = http.client.HTTPConnection(host, port, timeout=2)
                connection.request(
                    "POST",
                    "/compile",
                    body=json.dumps({"fqbn": app.ALLOWED_FQBN, "source": SOURCE}),
                    headers={"content-type": "application/json"},
                )
                accepted = connection.getresponse()
                accepted_body = accepted.read()
                connection.close()

                oversized = http.client.HTTPConnection(host, port, timeout=2)
                oversized.putrequest("POST", "/compile")
                oversized.putheader("content-type", "application/json")
                oversized.putheader("content-length", str(app.MAX_REQUEST_BYTES + 1))
                oversized.endheaders()
                rejected = oversized.getresponse()
                rejected_body = rejected.read()
                oversized.close()

            self.assertEqual(accepted.status, 200)
            self.assertLessEqual(len(accepted_body), app.MAX_RESULT_BYTES)
            self.assertEqual(rejected.status, 413)
            self.assertEqual(
                json.loads(rejected_body)["error"]["code"],
                "COMPILER_REQUEST_TOO_LARGE",
            )
        finally:
            server.shutdown()
            server.server_close()
            server_thread.join(timeout=2)

    def test_each_task_allows_only_one_compile_at_a_time(self):
        server = app._BoundedThreadingHTTPServer(
            ("127.0.0.1", 0), app._CompilerRequestHandler
        )
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        host, port = server.server_address
        entered = threading.Event()
        release = threading.Event()
        first_status: list[int] = []

        def hold_compile(_: object) -> dict[str, object]:
            entered.set()
            release.wait(timeout=2)
            return app._error_response("compile_failed", 422)

        def first_request() -> None:
            connection = http.client.HTTPConnection(host, port, timeout=3)
            connection.request(
                "POST",
                "/compile",
                body=json.dumps({"fqbn": app.ALLOWED_FQBN, "source": SOURCE}),
                headers={"content-type": "application/json"},
            )
            response = connection.getresponse()
            first_status.append(response.status)
            response.read()
            connection.close()

        request_thread = threading.Thread(target=first_request, daemon=True)
        try:
            with mock.patch.object(app, "isolated_handle_event", side_effect=hold_compile):
                request_thread.start()
                self.assertTrue(entered.wait(timeout=1))

                second = http.client.HTTPConnection(host, port, timeout=2)
                second.request(
                    "POST",
                    "/compile",
                    body=json.dumps({"fqbn": app.ALLOWED_FQBN, "source": SOURCE}),
                    headers={"content-type": "application/json"},
                )
                busy = second.getresponse()
                busy_body = json.loads(busy.read())
                second.close()

                self.assertEqual(busy.status, 503)
                self.assertEqual(
                    busy_body["error"]["code"], "COMPILER_UNAVAILABLE"
                )
                release.set()
                request_thread.join(timeout=2)
                self.assertEqual(first_status, [422])
        finally:
            release.set()
            request_thread.join(timeout=2)
            server.shutdown()
            server.server_close()
            server_thread.join(timeout=2)


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
        self.assertEqual(
            command[command.index("--libraries") + 1], app.ARDUINO_LIBRARIES
        )
        self.assertEqual(command[command.index("--jobs") + 1], "1")
        self.assertEqual(observed["timeout_seconds"], 40.0)
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
