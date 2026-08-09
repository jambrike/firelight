from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))
sys.path.insert(0, str(SERVICE_ROOT / "scripts"))

import app  # noqa: E402
from probe_deployment import (  # noqa: E402
    ProbeError,
    expected_error,
    parse_configuration,
    read_source,
    run_probe,
)


TOKEN = "compiler-probe-token-that-is-never-printed-12345"
HOST = "abcdefghij123456.lambda-url.eu-west-1.on.aws"
SOURCE = "void setup() {}\nvoid loop() {}\n"
VALID_HEX = ":020000000C945E\n:00000001FF\n"
BUILD_ID = "a" * 40
IMAGE_DIGEST = f"sha256:{'b' * 64}"


def environment(**overrides: str) -> dict[str, str]:
    return {
        "COMPILER_SERVICE_URL": f"https://{HOST}/",
        "COMPILER_SERVICE_ORIGIN": f"https://{HOST}",
        "COMPILER_SERVICE_HOST": HOST,
        "COMPILER_SERVICE_TOKEN": TOKEN,
        "FIRELIGHT_COMPILER_ENVIRONMENT": "staging",
        "FIRELIGHT_COMPILER_RELEASE_BUILD_ID": BUILD_ID,
        "FIRELIGHT_COMPILER_IMAGE_DIGEST": IMAGE_DIGEST,
        **overrides,
    }


class FakeResponse:
    def __init__(self, status: int, body: object, headers: dict[str, str] | None = None):
        self.status = status
        self.raw = json.dumps(body, separators=(",", ":")).encode()
        self.headers = {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "content-length": str(len(self.raw)),
            **(headers or {}),
        }

    def read(self, maximum: int) -> bytes:
        return self.raw[:maximum]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        del args
        return False


class FakeOpener:
    def __init__(self, responses: list[FakeResponse]):
        self.responses = list(responses)
        self.requests = []

    def open(self, request, *, timeout: int):
        self.requests.append((request, timeout))
        return self.responses.pop(0)


def artifact(source: str = SOURCE, hex_text: str = VALID_HEX) -> dict[str, object]:
    return {
        "artifact": {
            "artifactHash": hashlib.sha256(hex_text.encode()).hexdigest(),
            "format": app.ARTIFACT_FORMAT,
            "fqbn": app.ALLOWED_FQBN,
            "hex": hex_text,
            "sourceHash": hashlib.sha256(source.encode()).hexdigest(),
        },
        "diagnostics": [],
        "identity": {
            "buildId": BUILD_ID,
            "environment": "staging",
            "imageDigest": IMAGE_DIGEST,
            "protocolVersion": app.COMPILER_PROTOCOL_VERSION,
            "serviceName": "firelight-compiler-stg",
        },
        "ok": True,
    }


def valid_responses(source: str = SOURCE) -> list[FakeResponse]:
    return [
        FakeResponse(
            401,
            expected_error(
                "COMPILER_UNAUTHORIZED",
                "The request is not authorized.",
            ),
        ),
        FakeResponse(
            200,
            {
                "identity": {
                    "buildId": BUILD_ID,
                    "environment": "staging",
                    "imageDigest": IMAGE_DIGEST,
                    "protocolVersion": app.COMPILER_PROTOCOL_VERSION,
                    "serviceName": "firelight-compiler-stg",
                },
                "ok": True,
            },
        ),
        FakeResponse(200, artifact(source)),
    ]


class CompilerDeploymentProbeTests(unittest.TestCase):
    def test_configuration_binds_exact_function_url_origin_host_and_token(self):
        parsed = parse_configuration(environment())
        self.assertEqual(parsed.url, f"https://{HOST}/")
        for overrides, code in [
            ({"COMPILER_SERVICE_URL": "https://example.com/"}, "INVALID_COMPILER_SERVICE_URL"),
            ({"COMPILER_SERVICE_URL": f"https://{HOST}/compile"}, "INVALID_COMPILER_SERVICE_URL"),
            ({"COMPILER_SERVICE_ORIGIN": "https://example.com"}, "COMPILER_SERVICE_IDENTITY_MISMATCH"),
            ({"COMPILER_SERVICE_HOST": "example.com"}, "COMPILER_SERVICE_IDENTITY_MISMATCH"),
            ({"COMPILER_SERVICE_TOKEN": "short"}, "INVALID_COMPILER_SERVICE_TOKEN"),
            ({"FIRELIGHT_COMPILER_ENVIRONMENT": "development"}, "INVALID_FIRELIGHT_COMPILER_ENVIRONMENT"),
            ({"FIRELIGHT_COMPILER_RELEASE_BUILD_ID": "A" * 40}, "INVALID_FIRELIGHT_COMPILER_RELEASE_BUILD_ID"),
            ({"FIRELIGHT_COMPILER_RELEASE_BUILD_ID": "0" * 40}, "INVALID_FIRELIGHT_COMPILER_RELEASE_BUILD_ID"),
            ({"FIRELIGHT_COMPILER_IMAGE_DIGEST": f"sha256:{'0' * 64}"}, "INVALID_FIRELIGHT_COMPILER_IMAGE_DIGEST"),
        ]:
            with self.subTest(code=code), self.assertRaisesRegex(ProbeError, f"^{code}$"):
                parse_configuration(environment(**overrides))

    def test_source_file_is_regular_bounded_utf8(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_path = root / "source.ino"
            source_path.write_text(SOURCE, encoding="utf-8")
            self.assertEqual(read_source(source_path), SOURCE)

            link = root / "link.ino"
            link.symlink_to(source_path)
            with self.assertRaisesRegex(ProbeError, "^PROBE_SOURCE_NOT_REGULAR_FILE$"):
                read_source(link)

            source_path.write_bytes(b"\xff")
            with self.assertRaisesRegex(ProbeError, "^PROBE_SOURCE_NOT_UTF8$"):
                read_source(source_path)

    def test_probe_requires_unauthorized_authenticated_identity_and_compile(self):
        configuration = parse_configuration(environment())
        opener = FakeOpener(valid_responses())
        source_hash, artifact_hash = run_probe(configuration, SOURCE, opener)
        self.assertEqual(source_hash, hashlib.sha256(SOURCE.encode()).hexdigest())
        self.assertEqual(artifact_hash, hashlib.sha256(VALID_HEX.encode()).hexdigest())
        self.assertEqual([request.get_method() for request, _ in opener.requests], ["POST", "GET", "POST"])
        self.assertEqual([timeout for _, timeout in opener.requests], [45, 45, 45])
        unauthenticated_headers = dict(opener.requests[0][0].header_items())
        authenticated_headers = dict(opener.requests[1][0].header_items())
        self.assertNotIn("X-firelight-compiler-token", unauthenticated_headers)
        self.assertEqual(
            authenticated_headers["X-firelight-compiler-token"],
            TOKEN,
        )

    def test_identity_proof_requires_authentication_and_exact_release(self):
        responses = valid_responses()
        responses[1] = FakeResponse(
            200,
            {
                "identity": {
                    "buildId": "c" * 40,
                    "environment": "staging",
                    "imageDigest": IMAGE_DIGEST,
                    "protocolVersion": app.COMPILER_PROTOCOL_VERSION,
                    "serviceName": "firelight-compiler-stg",
                },
                "ok": True,
            },
        )
        with self.assertRaisesRegex(
            ProbeError,
            "^COMPILER_AUTHENTICATED_IDENTITY_PROBE_FAILED$",
        ):
            run_probe(parse_configuration(environment()), SOURCE, FakeOpener(responses))

        responses = valid_responses()
        responses[2] = FakeResponse(
            200,
            {**artifact(), "identity": {**artifact()["identity"], "imageDigest": f"sha256:{'c' * 64}"}},
        )
        with self.assertRaisesRegex(ProbeError, "^COMPILER_COMPILE_PROBE_FAILED$"):
            run_probe(parse_configuration(environment()), SOURCE, FakeOpener(responses))

    def test_compile_proof_recomputes_source_hex_and_artifact_hashes(self):
        for mutation in (
            {"sourceHash": "0" * 64},
            {"artifactHash": "0" * 64},
            {"fqbn": "arduino:avr:uno"},
            {"hex": ":00000001FE\n"},
        ):
            responses = valid_responses()
            body = artifact()
            body["artifact"].update(mutation)
            responses[2] = FakeResponse(200, body)
            with self.subTest(mutation=mutation), self.assertRaisesRegex(
                ProbeError,
                "^COMPILER_ARTIFACT_INVALID$",
            ):
                run_probe(parse_configuration(environment()), SOURCE, FakeOpener(responses))

    def test_response_security_headers_fail_closed(self):
        cases = [
            ({"content-type": "text/plain"}, "COMPILER_RESPONSE_CONTENT_TYPE_INVALID"),
            ({"cache-control": "public"}, "COMPILER_RESPONSE_CACHE_POLICY_INVALID"),
            ({"access-control-allow-origin": "*"}, "COMPILER_RESPONSE_CORS_INVALID"),
        ]
        for headers, code in cases:
            responses = valid_responses()
            responses[0] = FakeResponse(
                401,
                expected_error(
                    "COMPILER_UNAUTHORIZED",
                    "The request is not authorized.",
                ),
                headers,
            )
            with self.subTest(code=code), self.assertRaisesRegex(ProbeError, f"^{code}$"):
                run_probe(parse_configuration(environment()), SOURCE, FakeOpener(responses))


if __name__ == "__main__":
    unittest.main()
