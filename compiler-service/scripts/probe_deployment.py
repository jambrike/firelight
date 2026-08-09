#!/usr/bin/env python3
"""Bounded, redacted acceptance probe for the deployed compiler gateway."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

import app  # noqa: E402


MAX_RESPONSE_BYTES = 192 * 1024
REQUEST_TIMEOUT_SECONDS = 45
FUNCTION_HOST = re.compile(
    r"^[a-z0-9]{10,64}\.lambda-url\.eu-west-1\.on\.aws$"
)
BUILD_ID = re.compile(r"^[0-9a-f]{40}$")
IMAGE_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
SERVICE_NAMES = {
    "staging": "firelight-compiler-stg",
    "production": "firelight-compiler-prd",
}


class ProbeError(RuntimeError):
    pass


def fail(code: str) -> None:
    raise ProbeError(code)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        del args, kwargs
        return None


@dataclass(frozen=True)
class ProbeConfiguration:
    url: str
    origin: str
    host: str
    token: str
    environment: str
    service_name: str
    build_id: str
    image_digest: str

    def expected_identity(self) -> dict[str, str | int]:
        return {
            "buildId": self.build_id,
            "environment": self.environment,
            "imageDigest": self.image_digest,
            "protocolVersion": app.COMPILER_PROTOCOL_VERSION,
            "serviceName": self.service_name,
        }


def required(environment: Mapping[str, str], name: str, maximum: int) -> str:
    value = environment.get(name, "")
    if not value or len(value) > maximum or value.strip() != value:
        fail(f"INVALID_{name}")
    return value


def parse_configuration(environment: Mapping[str, str]) -> ProbeConfiguration:
    url = required(environment, "COMPILER_SERVICE_URL", 2048)
    origin = required(environment, "COMPILER_SERVICE_ORIGIN", 2048)
    host = required(environment, "COMPILER_SERVICE_HOST", 253)
    token = required(environment, "COMPILER_SERVICE_TOKEN", 512)
    release_environment = required(
        environment,
        "FIRELIGHT_COMPILER_ENVIRONMENT",
        10,
    )
    service_name = SERVICE_NAMES.get(release_environment)
    build_id = required(environment, "FIRELIGHT_COMPILER_RELEASE_BUILD_ID", 40)
    image_digest = required(environment, "FIRELIGHT_COMPILER_IMAGE_DIGEST", 71)
    if len(token.encode("utf-8")) < 32 or any(character.isspace() for character in token):
        fail("INVALID_COMPILER_SERVICE_TOKEN")
    if service_name is None:
        fail("INVALID_FIRELIGHT_COMPILER_ENVIRONMENT")
    if not BUILD_ID.fullmatch(build_id) or build_id == "0" * 40:
        fail("INVALID_FIRELIGHT_COMPILER_RELEASE_BUILD_ID")
    if (
        not IMAGE_DIGEST.fullmatch(image_digest)
        or image_digest == f"sha256:{'0' * 64}"
    ):
        fail("INVALID_FIRELIGHT_COMPILER_IMAGE_DIGEST")

    try:
        parsed = urllib.parse.urlsplit(url)
        parsed_origin = urllib.parse.urlsplit(origin)
    except ValueError as error:
        raise ProbeError("INVALID_COMPILER_SERVICE_URL") from error
    if (
        parsed.scheme != "https"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port is not None
        or parsed.hostname is None
        or not FUNCTION_HOST.fullmatch(parsed.hostname)
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        fail("INVALID_COMPILER_SERVICE_URL")
    expected_origin = f"https://{parsed.hostname}"
    if (
        origin != expected_origin
        or parsed_origin.scheme != "https"
        or parsed_origin.hostname != parsed.hostname
        or parsed_origin.path
        or parsed_origin.query
        or parsed_origin.fragment
        or host != parsed.hostname
    ):
        fail("COMPILER_SERVICE_IDENTITY_MISMATCH")
    return ProbeConfiguration(
        url=f"{expected_origin}/",
        origin=origin,
        host=host,
        token=token,
        environment=release_environment,
        service_name=service_name,
        build_id=build_id,
        image_digest=image_digest,
    )


def read_source(path: Path) -> str:
    try:
        if path.is_symlink() or not path.is_file():
            fail("PROBE_SOURCE_NOT_REGULAR_FILE")
        raw = path.read_bytes()
    except OSError as error:
        raise ProbeError("PROBE_SOURCE_READ_FAILED") from error
    if not raw or len(raw) > app.MAX_SOURCE_BYTES:
        fail("PROBE_SOURCE_SIZE_INVALID")
    try:
        source = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ProbeError("PROBE_SOURCE_NOT_UTF8") from error
    if "\x00" in source:
        fail("PROBE_SOURCE_NOT_UTF8")
    return source


def decode_json(raw: bytes) -> Any:
    try:
        text = raw.decode("utf-8")
        return json.loads(text, object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProbeError("COMPILER_RESPONSE_INVALID") from error


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail("COMPILER_RESPONSE_INVALID")
        result[key] = value
    return result


def _read_response(response: Any) -> tuple[int, Mapping[str, str], bytes]:
    raw = response.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        fail("COMPILER_RESPONSE_TOO_LARGE")
    headers = {str(key).lower(): str(value) for key, value in response.headers.items()}
    declared_length = headers.get("content-length")
    if declared_length is not None:
        if not declared_length.isdigit() or int(declared_length) != len(raw):
            fail("COMPILER_RESPONSE_LENGTH_INVALID")
    return int(response.status), headers, raw


def request(
    opener: Any,
    configuration: ProbeConfiguration,
    *,
    method: str,
    source: str,
    authenticated: bool,
) -> tuple[int, Mapping[str, str], Any]:
    body = json.dumps(
        {"fqbn": app.ALLOWED_FQBN, "source": source},
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    headers = {
        "accept": "application/json",
        "content-type": "application/json",
        "user-agent": "firelight-compiler-release-probe",
    }
    if authenticated:
        headers[app.AUTH_HEADER] = configuration.token
    request_value = urllib.request.Request(
        configuration.url,
        data=body if method == "POST" else None,
        headers=headers,
        method=method,
    )
    try:
        with opener.open(
            request_value,
            timeout=REQUEST_TIMEOUT_SECONDS,
        ) as response:
            status, response_headers, raw = _read_response(response)
    except urllib.error.HTTPError as error:
        status, response_headers, raw = _read_response(error)
    except ProbeError:
        raise
    except (OSError, TimeoutError, ValueError) as error:
        raise ProbeError("COMPILER_REQUEST_FAILED") from error

    if response_headers.get("content-type") != "application/json; charset=utf-8":
        fail("COMPILER_RESPONSE_CONTENT_TYPE_INVALID")
    if response_headers.get("cache-control") != "no-store":
        fail("COMPILER_RESPONSE_CACHE_POLICY_INVALID")
    if "access-control-allow-origin" in response_headers:
        fail("COMPILER_RESPONSE_CORS_INVALID")
    return status, response_headers, decode_json(raw)


def expected_error(code: str, message: str) -> dict[str, Any]:
    return {
        "diagnostics": [],
        "error": {"code": code, "message": message},
        "ok": False,
    }


def run_probe(
    configuration: ProbeConfiguration,
    source: str,
    opener: Any | None = None,
) -> tuple[str, str]:
    if opener is None:
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            NoRedirect(),
        )

    unauthorized_status, _, unauthorized = request(
        opener,
        configuration,
        method="POST",
        source=source,
        authenticated=False,
    )
    if unauthorized_status != 401 or unauthorized != expected_error(
        "COMPILER_UNAUTHORIZED",
        "The request is not authorized.",
    ):
        fail("COMPILER_UNAUTHORIZED_PROBE_FAILED")

    identity_status, _, identity = request(
        opener,
        configuration,
        method="GET",
        source=source,
        authenticated=True,
    )
    if identity_status != 200 or identity != {
        "identity": configuration.expected_identity(),
        "ok": True,
    }:
        fail("COMPILER_AUTHENTICATED_IDENTITY_PROBE_FAILED")

    status, _, payload = request(
        opener,
        configuration,
        method="POST",
        source=source,
        authenticated=True,
    )
    if (
        status != 200
        or not isinstance(payload, dict)
        or set(payload) != {"artifact", "diagnostics", "identity", "ok"}
        or payload.get("ok") is not True
        or payload.get("diagnostics") != []
        or payload.get("identity") != configuration.expected_identity()
        or not isinstance(payload.get("artifact"), dict)
    ):
        fail("COMPILER_COMPILE_PROBE_FAILED")
    artifact = payload["artifact"]
    if set(artifact) != {"artifactHash", "format", "fqbn", "hex", "sourceHash"}:
        fail("COMPILER_ARTIFACT_INVALID")
    expected_source_hash = hashlib.sha256(source.encode("utf-8")).hexdigest()
    hex_text = artifact.get("hex")
    if (
        artifact.get("format") != app.ARTIFACT_FORMAT
        or artifact.get("fqbn") != app.ALLOWED_FQBN
        or artifact.get("sourceHash") != expected_source_hash
        or not isinstance(hex_text, str)
        or len(hex_text.encode("utf-8")) > app.MAX_HEX_BYTES
    ):
        fail("COMPILER_ARTIFACT_INVALID")
    try:
        app._validate_intel_hex(hex_text)
    except app.CompilerError as error:
        raise ProbeError("COMPILER_ARTIFACT_INVALID") from error
    artifact_hash = hashlib.sha256(hex_text.encode("utf-8")).hexdigest()
    if artifact.get("artifactHash") != artifact_hash:
        fail("COMPILER_ARTIFACT_INVALID")
    return expected_source_hash, artifact_hash


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-file", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    configuration = parse_configuration(os.environ)
    source = read_source(args.source_file)
    source_hash, artifact_hash = run_probe(configuration, source)
    print(f"compiler_probe_source_hash={source_hash}")
    print(f"compiler_probe_artifact_hash={artifact_hash}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except ProbeError as error:
        print(f"Compiler deployment probe failed [{error}].", file=sys.stderr)
        raise SystemExit(1) from None
