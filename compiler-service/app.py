"""Firelight's bounded Arduino Nano compiler and authenticated gateway.

The module intentionally has no application dependencies. A public Lambda
gateway authenticates the Cloudflare Worker and forwards bounded source to an
internal Fargate service. Only the Fargate process invokes the toolchain; its ECS
task has no task role or application secrets. The Lambda Python base image
supplies boto3 for the gateway's one cold-start Secrets Manager read.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import http.server
import json
import os
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence


ALLOWED_FQBN = "arduino:avr:nano:cpu=atmega328old"
ARTIFACT_FORMAT = "intel-hex"
AUTH_HEADER = "x-firelight-compiler-token"

MAX_REQUEST_BYTES = 512 * 1024
MAX_SOURCE_BYTES = 64 * 1024
MAX_COMPILER_OUTPUT_BYTES = 64 * 1024
MAX_DIAGNOSTIC_BYTES = 8 * 1024
MAX_DIAGNOSTIC_LINES = 16
MAX_DIAGNOSTIC_LINE_BYTES = 512
MAX_HEX_BYTES = 128 * 1024
MAX_RESULT_BYTES = 192 * 1024
MAX_FLASH_BYTES = 30_720
COMPILE_TIMEOUT_SECONDS = 40.0
GATEWAY_FORWARD_TIMEOUT_SECONDS = 42.0
INTERNAL_COMPILER_PORT = 8080
INTERNAL_HTTP_IO_TIMEOUT_SECONDS = 5.0
INTERNAL_COMPILE_CONCURRENCY = 1

ARDUINO_CLI = os.environ.get("ARDUINO_CLI_PATH", "/usr/local/bin/arduino-cli")
ARDUINO_CONFIG = os.environ.get(
    "ARDUINO_CLI_CONFIG_PATH", "/opt/arduino/arduino-cli.yaml"
)
ARDUINO_LIBRARIES = "/opt/arduino/libraries"

_ERROR_MESSAGES = {
    "artifact_invalid": "The compiler produced an invalid artifact.",
    "artifact_too_large": "The compiled artifact exceeds the service limit.",
    "compile_failed": "The sketch did not compile.",
    "compile_timeout": "The sketch exceeded the compile time limit.",
    "compiler_unavailable": "The compiler is temporarily unavailable.",
    "internal_error": "The compiler could not complete the request.",
    "invalid_request": "The request is invalid.",
    "method_not_allowed": "Only POST requests are accepted.",
    "request_too_large": "The request exceeds the service limit.",
    "source_too_large": "The source exceeds the 64 KiB limit.",
    "source_policy_rejected": "The sketch uses a compiler feature that Firelight lessons do not allow.",
    "unauthorized": "The request is not authorized.",
    "unsupported_media_type": "Content-Type must be application/json.",
    "unsupported_target": "The requested board target is not supported.",
}
_PUBLIC_ERROR_CODES = {
    "artifact_invalid": "COMPILER_ARTIFACT_INVALID",
    "artifact_too_large": "COMPILER_ARTIFACT_TOO_LARGE",
    "compile_failed": "COMPILER_FAILED",
    "compile_timeout": "COMPILER_TIMEOUT",
    "compiler_unavailable": "COMPILER_UNAVAILABLE",
    "internal_error": "COMPILER_INTERNAL_ERROR",
    "invalid_request": "COMPILER_INVALID_REQUEST",
    "method_not_allowed": "COMPILER_METHOD_NOT_ALLOWED",
    "request_too_large": "COMPILER_REQUEST_TOO_LARGE",
    "source_too_large": "COMPILER_SOURCE_TOO_LARGE",
    "source_policy_rejected": "COMPILER_SOURCE_POLICY_REJECTED",
    "unauthorized": "COMPILER_UNAUTHORIZED",
    "unsupported_media_type": "COMPILER_UNSUPPORTED_MEDIA_TYPE",
    "unsupported_target": "COMPILER_UNSUPPORTED_TARGET",
}

_RESPONSE_HEADERS = {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
}

_ANSI_ESCAPE_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_PATH_RE = re.compile(
    r"(?<![A-Za-z0-9_])/(?:[^/\s:'\"]+/)*[^/\s:'\"]+"
)
_URL_RE = re.compile(r"(?i)\b[a-z][a-z0-9+.-]*://[^\s<>\"']+")
_STRUCTURED_DIAGNOSTIC_RE = re.compile(
    r"(?i)^(?:\[redacted\])*(?:\[path\]|[A-Za-z0-9_.-]+\.(?:ino|c|cc|cpp|h|hpp)):"
    r"\d+(?::\d+)?:\s*(?:fatal error|error|warning|note)\s*:"
)
_GLOBAL_DIAGNOSTIC_RE = re.compile(
    r"(?i)^(?:error during build|compilation failed|exit status)\b"
)
_ALLOWED_PREPROCESSOR_RE = re.compile(
    r"^\s*#\s*include\s*<Servo\.h>\s*(?://.*)?$"
)
_FORBIDDEN_SOURCE_RE = re.compile(
    r"(?i)(?:\b(?:asm|__asm|__asm__|__attribute__|__has_include|include_next)\b|"
    r"\.(?:incbin|include)\b|\.\./|/proc/|/etc/|/var/|/tmp/|file://|%:|\?\?=)"
)
_FORBIDDEN_TRANSLATION_RE = re.compile(
    r'(?:\\(?:\r\n|\r|\n)|\?\?[=/\'()!<>-]|%:|(?:\bu8|\b[LuU])?R")'
)


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    """Keep the gateway pinned to its Terraform-provided internal ALB."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        del args, kwargs
        return None


_internal_http_opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({}),
    _RejectRedirects(),
)


@dataclass(frozen=True)
class ProcessResult:
    returncode: int
    stdout: bytes
    stderr: bytes
    timed_out: bool = False
    output_truncated: bool = False


@dataclass(frozen=True)
class CompileArtifact:
    fqbn: str
    source_hash: str
    artifact_hash: str
    hex_text: str
    format: str = ARTIFACT_FORMAT


class CompilerError(Exception):
    """A safe, expected failure with a stable public error code."""

    def __init__(
        self,
        code: str,
        *,
        status: int,
        diagnostics: Sequence[str] = (),
    ) -> None:
        if code not in _ERROR_MESSAGES:
            raise ValueError("unknown compiler error code")
        super().__init__(code)
        self.code = code
        self.status = status
        self.diagnostics = tuple(diagnostics)


def _json_response(status: int, payload: Mapping[str, Any]) -> dict[str, Any]:
    body = json.dumps(
        payload,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    )
    if len(body.encode("utf-8")) > MAX_RESULT_BYTES:
        status = 500
        body = json.dumps(
            {
                "error": {
                    "code": _PUBLIC_ERROR_CODES["internal_error"],
                    "message": _ERROR_MESSAGES["internal_error"],
                },
                "ok": False,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    return {
        "statusCode": status,
        "headers": dict(_RESPONSE_HEADERS),
        "isBase64Encoded": False,
        "body": body,
    }


def _error_response(
    code: str,
    status: int,
    diagnostics: Sequence[str] = (),
) -> dict[str, Any]:
    error: dict[str, Any] = {
        "code": _PUBLIC_ERROR_CODES[code],
        "message": _ERROR_MESSAGES[code],
    }
    return _json_response(
        status,
        {"ok": False, "error": error, "diagnostics": list(diagnostics)},
    )


def _normalise_headers(event: Mapping[str, Any]) -> dict[str, str]:
    raw_headers = event.get("headers")
    if not isinstance(raw_headers, Mapping):
        return {}
    return {
        str(name).lower(): value
        for name, value in raw_headers.items()
        if isinstance(value, str)
    }


def _request_method(event: Mapping[str, Any]) -> str:
    context = event.get("requestContext")
    if isinstance(context, Mapping):
        http = context.get("http")
        if isinstance(http, Mapping) and isinstance(http.get("method"), str):
            return str(http["method"]).upper()
    if isinstance(event.get("httpMethod"), str):
        return str(event["httpMethod"]).upper()
    return ""


def _authenticate(supplied: str, expected: str) -> bool:
    """Compare fixed-size digests so token length does not affect comparison time."""

    supplied_digest = hashlib.sha256(supplied.encode("utf-8", "surrogatepass")).digest()
    expected_digest = hashlib.sha256(expected.encode("utf-8", "surrogatepass")).digest()
    return bool(supplied) and hmac.compare_digest(supplied_digest, expected_digest)


_secret_lock = threading.Lock()
_secret_value: str | None = None
_secret_loaded_at = 0.0
_SECRET_CACHE_SECONDS = 300.0


def _validate_service_token(token: Any) -> str:
    if not isinstance(token, str):
        raise RuntimeError("invalid service secret")
    encoded = token.encode("utf-8")
    if not 32 <= len(encoded) <= 512:
        raise RuntimeError("invalid service secret")
    contains_control = any(
        ord(character) < 32 or ord(character) == 127 for character in token
    )
    if token != token.strip() or contains_control:
        raise RuntimeError("invalid service secret")
    return token


def _load_service_token() -> str:
    """Read and briefly cache a raw SecretString without logging its value."""

    global _secret_loaded_at, _secret_value

    now = time.monotonic()
    if _secret_value is not None and now - _secret_loaded_at < _SECRET_CACHE_SECONDS:
        return _secret_value

    with _secret_lock:
        now = time.monotonic()
        if _secret_value is not None and now - _secret_loaded_at < _SECRET_CACHE_SECONDS:
            return _secret_value

        secret_arn = os.environ.get("FIRELIGHT_COMPILER_SECRET_ARN", "")
        if not secret_arn:
            raise RuntimeError("service secret is not configured")

        # boto3 and botocore are supplied and version-pinned by the Lambda base image.
        import boto3  # type: ignore[import-not-found]
        from botocore.config import Config  # type: ignore[import-not-found]

        client = boto3.client(
            "secretsmanager",
            region_name="eu-west-1",
            config=Config(
                connect_timeout=1,
                read_timeout=1,
                retries={"max_attempts": 1, "mode": "standard"},
            ),
        )
        response = client.get_secret_value(SecretId=secret_arn)
        token = _validate_service_token(response.get("SecretString"))
        _secret_value = token
        _secret_loaded_at = now
        return token


def _decode_body(event: Mapping[str, Any]) -> bytes:
    body = event.get("body")
    if not isinstance(body, str):
        raise CompilerError("invalid_request", status=400)

    if event.get("isBase64Encoded") is True:
        encoded_limit = ((MAX_REQUEST_BYTES + 2) // 3) * 4 + 4
        if len(body) > encoded_limit:
            raise CompilerError("request_too_large", status=413)
        try:
            decoded = base64.b64decode(body, validate=True)
        except (binascii.Error, ValueError):
            raise CompilerError("invalid_request", status=400) from None
    else:
        try:
            decoded = body.encode("utf-8")
        except UnicodeEncodeError:
            raise CompilerError("invalid_request", status=400) from None

    if len(decoded) > MAX_REQUEST_BYTES:
        raise CompilerError("request_too_large", status=413)
    return decoded


def _reject_json_constant(_: str) -> None:
    raise ValueError("non-finite JSON number")


def _unique_json_object(pairs: Sequence[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _parse_request(event: Mapping[str, Any]) -> tuple[str, str]:
    headers = _normalise_headers(event)
    content_type = headers.get("content-type", "")
    media_type = content_type.split(";", 1)[0].strip().lower()
    if media_type != "application/json":
        raise CompilerError("unsupported_media_type", status=415)

    raw_body = _decode_body(event)
    try:
        payload = json.loads(
            raw_body.decode("utf-8"),
            parse_constant=_reject_json_constant,
            object_pairs_hook=_unique_json_object,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise CompilerError("invalid_request", status=400) from None

    if not isinstance(payload, dict) or set(payload) != {"fqbn", "source"}:
        raise CompilerError("invalid_request", status=400)

    fqbn = payload.get("fqbn")
    source = payload.get("source")
    if not isinstance(fqbn, str) or not isinstance(source, str):
        raise CompilerError("invalid_request", status=400)
    if fqbn != ALLOWED_FQBN:
        raise CompilerError("unsupported_target", status=422)
    if not source or "\x00" in source:
        raise CompilerError("invalid_request", status=400)

    try:
        source_size = len(source.encode("utf-8"))
    except UnicodeEncodeError:
        raise CompilerError("invalid_request", status=400) from None
    if source_size > MAX_SOURCE_BYTES:
        raise CompilerError("source_too_large", status=413)
    _validate_source_policy(source)
    return fqbn, source


def _validate_source_policy(source: str) -> None:
    """Reject compiler-controlled features before tool execution.

    The C translation phase removes backslash-newline pairs before tokenizing,
    and replaces comments before recognizing preprocessor directives. Reject
    alternate/spliced tokens outright and inspect the comment-masked form so a
    lexical trick cannot bypass the defense-in-depth policy. Process isolation,
    not this policy, remains the security boundary.
    """

    if _FORBIDDEN_TRANSLATION_RE.search(source):
        raise CompilerError("source_policy_rejected", status=422)
    source_without_comments = _mask_cpp_comments(source)
    for line in source_without_comments.splitlines():
        if line.lstrip().startswith("#") and not _ALLOWED_PREPROCESSOR_RE.fullmatch(line):
            raise CompilerError("source_policy_rejected", status=422)
    if _FORBIDDEN_SOURCE_RE.search(source_without_comments):
        raise CompilerError("source_policy_rejected", status=422)


def _mask_cpp_comments(source: str) -> str:
    """Mask C/C++ comments while retaining newlines and string contents."""

    output: list[str] = []
    index = 0
    state = "code"
    while index < len(source):
        character = source[index]
        following = source[index + 1] if index + 1 < len(source) else ""

        if state == "code":
            if character == "/" and following == "/":
                output.extend((" ", " "))
                index += 2
                state = "line-comment"
                continue
            if character == "/" and following == "*":
                output.extend((" ", " "))
                index += 2
                state = "block-comment"
                continue
            if character in ('"', "'"):
                state = "string" if character == '"' else "character"
            output.append(character)
            index += 1
            continue

        if state == "line-comment":
            output.append(character if character in "\r\n" else " ")
            index += 1
            if character == "\n":
                state = "code"
            continue

        if state == "block-comment":
            if character == "*" and following == "/":
                output.extend((" ", " "))
                index += 2
                state = "code"
            else:
                output.append(character if character in "\r\n" else " ")
                index += 1
            continue

        literal_state = state
        if character == "\\" and following:
            output.extend((character, following))
            index += 2
            continue
        output.append(character)
        index += 1
        if (literal_state == "string" and character == '"') or (
            literal_state == "character" and character == "'"
        ):
            state = "code"

    return "".join(output)


def _compiler_environment(work_root: Path) -> dict[str, str]:
    """Return an allowlisted child environment containing no AWS/service secrets."""

    return {
        "ARDUINO_DIRECTORIES_DATA": "/opt/arduino/data",
        "ARDUINO_DIRECTORIES_DOWNLOADS": str(work_root / "downloads"),
        "ARDUINO_DIRECTORIES_USER": str(work_root / "user"),
        "HOME": str(work_root),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "TMPDIR": str(work_root),
    }


def _kill_process_group(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            process.kill()
        except ProcessLookupError:
            pass


def _run_bounded(
    command: Sequence[str],
    *,
    cwd: Path,
    timeout_seconds: float,
    max_output_bytes: int,
    env: Mapping[str, str],
) -> ProcessResult:
    """Run one process group with a wall deadline and a shared output budget."""

    process = subprocess.Popen(
        list(command),
        cwd=str(cwd),
        env=dict(env),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        close_fds=True,
    )
    if process.stdout is None or process.stderr is None:
        _kill_process_group(process)
        raise RuntimeError("compiler pipes unavailable")

    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    chunks: dict[str, list[bytes]] = {"stdout": [], "stderr": []}
    captured = 0
    truncated = False
    timed_out = False
    deadline = time.monotonic() + timeout_seconds
    drain_deadline: float | None = None

    try:
        while selector.get_map():
            now = time.monotonic()
            if not timed_out and now >= deadline:
                timed_out = True
                drain_deadline = now + 1.0
                _kill_process_group(process)
            if timed_out and drain_deadline is not None and now >= drain_deadline:
                break

            wait_for = 0.05 if timed_out else min(0.1, max(0.0, deadline - now))
            for key, _ in selector.select(wait_for):
                try:
                    data = os.read(key.fd, 4096)
                except OSError:
                    data = b""
                if not data:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                remaining = max_output_bytes - captured
                if remaining > 0:
                    accepted = data[:remaining]
                    chunks[str(key.data)].append(accepted)
                    captured += len(accepted)
                if len(data) > max(0, remaining):
                    truncated = True

            if process.poll() is not None and not selector.get_map():
                break
    finally:
        selector.close()
        for stream in (process.stdout, process.stderr):
            if not stream.closed:
                stream.close()

    if process.poll() is None:
        _kill_process_group(process)
    try:
        returncode = process.wait(timeout=1.0)
    except subprocess.TimeoutExpired:
        process.kill()
        returncode = process.wait(timeout=1.0)

    return ProcessResult(
        returncode=returncode,
        stdout=b"".join(chunks["stdout"]),
        stderr=b"".join(chunks["stderr"]),
        timed_out=timed_out,
        output_truncated=truncated,
    )


def _safe_diagnostics(
    raw: str,
    *,
    redactions: Sequence[str] = (),
) -> tuple[str, ...]:
    """Return only severity lines, with paths, URLs, controls and secrets removed."""

    cleaned = _ANSI_ESCAPE_RE.sub("", raw)
    cleaned = _CONTROL_RE.sub("", cleaned)
    for value in sorted((item for item in redactions if item), key=len, reverse=True):
        cleaned = cleaned.replace(value, "[redacted]")
    cleaned = _URL_RE.sub("[redacted-url]", cleaned)
    cleaned = _PATH_RE.sub("[path]", cleaned)

    diagnostics: list[str] = []
    used_bytes = 0
    for candidate in cleaned.splitlines():
        line = " ".join(candidate.strip().split())
        if not line or not (
            _STRUCTURED_DIAGNOSTIC_RE.search(line)
            or _GLOBAL_DIAGNOSTIC_RE.search(line)
        ):
            continue
        encoded = line.encode("utf-8")[:MAX_DIAGNOSTIC_LINE_BYTES]
        line = encoded.decode("utf-8", "ignore")
        encoded = line.encode("utf-8")
        if not line or line in diagnostics:
            continue
        if len(diagnostics) >= MAX_DIAGNOSTIC_LINES:
            break
        if used_bytes + len(encoded) > MAX_DIAGNOSTIC_BYTES:
            break
        diagnostics.append(line)
        used_bytes += len(encoded)
    return tuple(diagnostics)


def _validate_intel_hex(hex_text: str) -> int:
    """Validate checksums/record flow and return unique flash payload bytes."""

    lines = hex_text.splitlines()
    if not lines:
        raise CompilerError("artifact_invalid", status=500)

    extended_address = 0
    written_addresses: set[int] = set()
    saw_eof = False

    for index, line in enumerate(lines):
        if (
            not line
            or len(line) < 11
            or not re.fullmatch(r":[0-9A-F]+", line)
            or len(line) % 2 == 0
        ):
            raise CompilerError("artifact_invalid", status=500)
        try:
            record = bytes.fromhex(line[1:])
        except ValueError:
            raise CompilerError("artifact_invalid", status=500) from None
        if len(record) < 5 or record[0] + 5 != len(record):
            raise CompilerError("artifact_invalid", status=500)
        if sum(record) & 0xFF:
            raise CompilerError("artifact_invalid", status=500)

        byte_count = record[0]
        address = (record[1] << 8) | record[2]
        record_type = record[3]
        data = record[4 : 4 + byte_count]

        if saw_eof:
            raise CompilerError("artifact_invalid", status=500)
        if record_type == 0x00:
            absolute = extended_address + address
            if absolute + byte_count > MAX_FLASH_BYTES:
                raise CompilerError("artifact_too_large", status=500)
            for flash_address in range(absolute, absolute + byte_count):
                if flash_address in written_addresses:
                    raise CompilerError("artifact_invalid", status=500)
                written_addresses.add(flash_address)
        elif record_type == 0x01:
            if byte_count != 0 or address != 0 or index != len(lines) - 1:
                raise CompilerError("artifact_invalid", status=500)
            saw_eof = True
        elif record_type == 0x02:
            if byte_count != 2 or address != 0:
                raise CompilerError("artifact_invalid", status=500)
            extended_address = int.from_bytes(data, "big") << 4
        elif record_type == 0x04:
            if byte_count != 2 or address != 0:
                raise CompilerError("artifact_invalid", status=500)
            extended_address = int.from_bytes(data, "big") << 16
        elif record_type == 0x03:
            if byte_count != 4 or address != 0:
                raise CompilerError("artifact_invalid", status=500)
        elif record_type == 0x05:
            if byte_count != 4 or address != 0:
                raise CompilerError("artifact_invalid", status=500)
        else:
            raise CompilerError("artifact_invalid", status=500)

    if not saw_eof or not written_addresses:
        raise CompilerError("artifact_invalid", status=500)
    return len(written_addresses)


Runner = Callable[..., ProcessResult]


def compile_sketch(
    source: str,
    *,
    runner: Runner = _run_bounded,
) -> CompileArtifact:
    try:
        source_bytes = source.encode("utf-8")
    except UnicodeEncodeError:
        raise CompilerError("invalid_request", status=400) from None
    if not source or b"\x00" in source_bytes or len(source_bytes) > MAX_SOURCE_BYTES:
        raise CompilerError("invalid_request", status=400)
    _validate_source_policy(source)
    source_hash = hashlib.sha256(source_bytes).hexdigest()

    with tempfile.TemporaryDirectory(prefix="firelight-compile-", dir="/tmp") as temp_dir:
        work_root = Path(temp_dir)
        sketch_dir = work_root / "FirelightSketch"
        build_dir = work_root / "build"
        output_dir = work_root / "output"
        sketch_dir.mkdir(mode=0o700)
        build_dir.mkdir(mode=0o700)
        output_dir.mkdir(mode=0o700)
        (work_root / "downloads").mkdir(mode=0o700)
        (work_root / "user").mkdir(mode=0o700)
        (sketch_dir / "FirelightSketch.ino").write_bytes(source_bytes)

        command = (
            ARDUINO_CLI,
            "--config-file",
            ARDUINO_CONFIG,
            "compile",
            "--fqbn",
            ALLOWED_FQBN,
            "--libraries",
            ARDUINO_LIBRARIES,
            "--build-path",
            str(build_dir),
            "--output-dir",
            str(output_dir),
            "--warnings",
            "all",
            "--jobs",
            "1",
            "--no-color",
            str(sketch_dir),
        )
        try:
            result = runner(
                command,
                cwd=work_root,
                timeout_seconds=COMPILE_TIMEOUT_SECONDS,
                max_output_bytes=MAX_COMPILER_OUTPUT_BYTES,
                env=_compiler_environment(work_root),
            )
        except (FileNotFoundError, PermissionError, OSError):
            raise CompilerError("compiler_unavailable", status=503) from None

        raw_output = (result.stderr + b"\n" + result.stdout).decode("utf-8", "replace")
        diagnostics = _safe_diagnostics(raw_output, redactions=(str(work_root),))
        if result.timed_out:
            raise CompilerError("compile_timeout", status=504)
        if result.returncode != 0:
            if result.output_truncated and len(diagnostics) < MAX_DIAGNOSTIC_LINES:
                diagnostics = (*diagnostics, "Compiler diagnostics were truncated.")
            raise CompilerError(
                "compile_failed",
                status=422,
                diagnostics=diagnostics,
            )

        candidates = sorted(
            path
            for path in output_dir.glob("*.hex")
            if "with_bootloader" not in path.name.lower()
        )
        if len(candidates) != 1:
            raise CompilerError("artifact_invalid", status=500)
        hex_path = candidates[0]
        try:
            if hex_path.is_symlink() or not hex_path.is_file():
                raise CompilerError("artifact_invalid", status=500)
            if hex_path.stat().st_size > MAX_HEX_BYTES:
                raise CompilerError("artifact_too_large", status=500)
            raw_hex = hex_path.read_bytes()
        except OSError:
            raise CompilerError("artifact_invalid", status=500) from None
        if len(raw_hex) > MAX_HEX_BYTES:
            raise CompilerError("artifact_too_large", status=500)
        try:
            hex_text = raw_hex.decode("ascii")
        except UnicodeDecodeError:
            raise CompilerError("artifact_invalid", status=500) from None

        contains_control = any(byte < 32 and byte not in (10, 13) for byte in raw_hex)
        contains_bare_cr = b"\r" in raw_hex.replace(b"\r\n", b"")
        if contains_control or contains_bare_cr:
            raise CompilerError("artifact_invalid", status=500)

        hex_text = "\n".join(hex_text.splitlines()) + "\n"
        if len(hex_text.encode("ascii")) > MAX_HEX_BYTES:
            raise CompilerError("artifact_too_large", status=500)
        _validate_intel_hex(hex_text)
        artifact_hash = hashlib.sha256(hex_text.encode("utf-8")).hexdigest()

    return CompileArtifact(
        fqbn=ALLOWED_FQBN,
        source_hash=source_hash,
        artifact_hash=artifact_hash,
        hex_text=hex_text,
    )


def handle_event(
    event: Any,
    *,
    token_loader: Callable[[], str] = _load_service_token,
    compile_fn: Callable[[str], CompileArtifact] = compile_sketch,
) -> dict[str, Any]:
    if not isinstance(event, Mapping):
        return _error_response("invalid_request", 400)

    try:
        expected_token = _validate_service_token(token_loader())
    except Exception:
        return _error_response("compiler_unavailable", 503)

    headers = _normalise_headers(event)
    supplied_token = headers.get(AUTH_HEADER, "")
    if not _authenticate(supplied_token, expected_token):
        return _error_response("unauthorized", 401)

    if _request_method(event) != "POST":
        response = _error_response("method_not_allowed", 405)
        response["headers"]["allow"] = "POST"
        return response

    try:
        _, source = _parse_request(event)
        artifact = compile_fn(source)
        payload = {
            "ok": True,
            "artifact": {
                "artifactHash": artifact.artifact_hash,
                "format": artifact.format,
                "fqbn": artifact.fqbn,
                "hex": artifact.hex_text,
                "sourceHash": artifact.source_hash,
            },
            "diagnostics": [],
        }
        return _json_response(200, payload)
    except CompilerError as error:
        diagnostics = _safe_diagnostics(
            "\n".join(error.diagnostics),
            redactions=(expected_token,),
        )
        return _error_response(error.code, error.status, diagnostics)
    except Exception:
        # Exception details can contain source, paths, URLs, environment, or secrets.
        return _error_response("internal_error", 500)


def _validate_internal_compiler_url(value: str) -> str:
    """Accept only the Terraform-managed eu-west-1 internal ALB endpoint."""

    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError):
        raise RuntimeError("internal compiler URL is invalid") from None
    hostname = parsed.hostname or ""
    if (
        parsed.scheme != "http"
        or not hostname.endswith(".eu-west-1.elb.amazonaws.com")
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 80)
        or parsed.path != "/compile"
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("internal compiler URL is invalid")
    return urllib.parse.urlunsplit(("http", parsed.netloc, "/compile", "", ""))


def _artifact_from_internal_response(
    status: int,
    raw_body: bytes,
    *,
    expected_source: str,
) -> CompileArtifact:
    if len(raw_body) > MAX_RESULT_BYTES:
        raise CompilerError("compiler_unavailable", status=503)
    try:
        payload = json.loads(
            raw_body.decode("utf-8"),
            parse_constant=_reject_json_constant,
            object_pairs_hook=_unique_json_object,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise CompilerError("compiler_unavailable", status=503) from None
    if not isinstance(payload, dict):
        raise CompilerError("compiler_unavailable", status=503)

    if status != 200:
        error = payload.get("error")
        code_lookup = {public: private for private, public in _PUBLIC_ERROR_CODES.items()}
        if not isinstance(error, dict) or not isinstance(error.get("code"), str):
            raise CompilerError("compiler_unavailable", status=503)
        private_code = code_lookup.get(error["code"])
        expected_statuses = {
            "artifact_invalid": 500,
            "artifact_too_large": 500,
            "compile_failed": 422,
            "compile_timeout": 504,
            "compiler_unavailable": 503,
            "internal_error": 500,
            "invalid_request": 400,
            "request_too_large": 413,
            "source_policy_rejected": 422,
            "source_too_large": 413,
            "unsupported_media_type": 415,
            "unsupported_target": 422,
        }
        if private_code is None or expected_statuses.get(private_code) != status:
            raise CompilerError("compiler_unavailable", status=503)
        diagnostics_value = payload.get("diagnostics", [])
        diagnostics = (
            tuple(item for item in diagnostics_value if isinstance(item, str))
            if isinstance(diagnostics_value, list)
            else ()
        )
        raise CompilerError(private_code, status=status, diagnostics=diagnostics)

    artifact_value = payload.get("artifact")
    if (
        set(payload) != {"artifact", "diagnostics", "ok"}
        or payload.get("ok") is not True
        or payload.get("diagnostics") != []
        or not isinstance(artifact_value, dict)
        or set(artifact_value)
        != {"artifactHash", "format", "fqbn", "hex", "sourceHash"}
    ):
        raise CompilerError("compiler_unavailable", status=503)
    expected_source_hash = hashlib.sha256(expected_source.encode("utf-8")).hexdigest()
    fqbn = artifact_value.get("fqbn")
    source_hash = artifact_value.get("sourceHash")
    artifact_hash = artifact_value.get("artifactHash")
    artifact_format = artifact_value.get("format")
    hex_text = artifact_value.get("hex")
    if (
        fqbn != ALLOWED_FQBN
        or source_hash != expected_source_hash
        or artifact_format != ARTIFACT_FORMAT
        or not isinstance(artifact_hash, str)
        or not re.fullmatch(r"[0-9a-f]{64}", artifact_hash)
        or not isinstance(hex_text, str)
        or len(hex_text.encode("utf-8", "surrogatepass")) > MAX_HEX_BYTES
    ):
        raise CompilerError("compiler_unavailable", status=503)
    _validate_intel_hex(hex_text)
    if not hmac.compare_digest(
        artifact_hash,
        hashlib.sha256(hex_text.encode("utf-8")).hexdigest(),
    ):
        raise CompilerError("compiler_unavailable", status=503)
    return CompileArtifact(
        fqbn=fqbn,
        source_hash=source_hash,
        artifact_hash=artifact_hash,
        hex_text=hex_text,
    )


def _invoke_isolated_compiler(source: str) -> CompileArtifact:
    """Forward a validated sketch to the SG-restricted internal ALB."""

    endpoint = _validate_internal_compiler_url(
        os.environ.get("FIRELIGHT_INTERNAL_COMPILER_URL", "")
    )
    body = json.dumps(
        {"fqbn": ALLOWED_FQBN, "source": source},
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with _internal_http_opener.open(
            request,
            timeout=GATEWAY_FORWARD_TIMEOUT_SECONDS,
        ) as response:
            raw_body = response.read(MAX_RESULT_BYTES + 1)
            return _artifact_from_internal_response(
                response.status,
                raw_body,
                expected_source=source,
            )
    except urllib.error.HTTPError as error:
        raw_body = error.read(MAX_RESULT_BYTES + 1)
        return _artifact_from_internal_response(
            error.code,
            raw_body,
            expected_source=source,
        )
    except CompilerError:
        raise
    except (OSError, TimeoutError, ValueError):
        raise CompilerError("compiler_unavailable", status=503) from None


def gateway_lambda_handler(event: Any, context: Any) -> dict[str, Any]:
    del context
    return handle_event(
        event,
        token_loader=_load_service_token,
        compile_fn=_invoke_isolated_compiler,
    )


# Keep the conventional Lambda name safe if an operator omits image_config.
lambda_handler = gateway_lambda_handler


def isolated_handle_event(
    event: Any,
    *,
    compile_fn: Callable[[str], CompileArtifact] = compile_sketch,
) -> dict[str, Any]:
    """Handle a request already authenticated by the network-isolated gateway."""

    if not isinstance(event, Mapping):
        return _error_response("invalid_request", 400)
    if _request_method(event) != "POST":
        response = _error_response("method_not_allowed", 405)
        response["headers"]["allow"] = "POST"
        return response
    try:
        _, source = _parse_request(event)
        artifact = compile_fn(source)
        return _json_response(
            200,
            {
                "ok": True,
                "artifact": {
                    "artifactHash": artifact.artifact_hash,
                    "format": artifact.format,
                    "fqbn": artifact.fqbn,
                    "hex": artifact.hex_text,
                    "sourceHash": artifact.source_hash,
                },
                "diagnostics": [],
            },
        )
    except CompilerError as error:
        diagnostics = _safe_diagnostics("\n".join(error.diagnostics))
        return _error_response(error.code, error.status, diagnostics)
    except Exception:
        return _error_response("internal_error", 500)


_internal_compile_slots = threading.BoundedSemaphore(INTERNAL_COMPILE_CONCURRENCY)


class _BoundedThreadingHTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8


class _CompilerRequestHandler(http.server.BaseHTTPRequestHandler):
    """Minimal internal HTTP surface; the ALB security group is the caller ACL."""

    server_version = "FirelightCompiler/1"
    sys_version = ""

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(INTERNAL_HTTP_IO_TIMEOUT_SECONDS)

    def log_message(self, format: str, *args: Any) -> None:
        # Access logs can accidentally capture learner-controlled paths/headers.
        del format, args

    def _send_json_response(self, response: Mapping[str, Any]) -> None:
        body = str(response["body"]).encode("utf-8")
        if len(body) > MAX_RESULT_BYTES:
            response = _error_response("internal_error", 500)
            body = str(response["body"]).encode("utf-8")
        self.send_response(int(response["statusCode"]))
        for name, value in response["headers"].items():
            self.send_header(str(name), str(value))
        self.send_header("connection", "close")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionError, OSError):
            pass

    def _send_not_found(self) -> None:
        self._send_json_response(_error_response("invalid_request", 404))

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        if self.path != "/healthz":
            self._send_not_found()
            return
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header("cache-control", "no-store")
        self.send_header("content-type", "application/json")
        self.send_header("connection", "close")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionError, OSError):
            pass

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        if self.path != "/compile":
            self._send_not_found()
            return
        content_lengths = self.headers.get_all("content-length", failobj=[])
        if len(content_lengths) != 1 or self.headers.get("transfer-encoding") is not None:
            self._send_json_response(_error_response("invalid_request", 400))
            return
        try:
            content_length = int(content_lengths[0])
        except ValueError:
            self._send_json_response(_error_response("invalid_request", 400))
            return
        if content_length < 0 or content_length > MAX_REQUEST_BYTES:
            self._send_json_response(_error_response("request_too_large", 413))
            return
        try:
            body = self.rfile.read(content_length)
        except (OSError, TimeoutError):
            self._send_json_response(_error_response("invalid_request", 400))
            return
        if len(body) != content_length:
            self._send_json_response(_error_response("invalid_request", 400))
            return
        try:
            text_body = body.decode("utf-8")
        except UnicodeDecodeError:
            self._send_json_response(_error_response("invalid_request", 400))
            return
        event = {
            "requestContext": {"http": {"method": "POST"}},
            "headers": {"content-type": self.headers.get("content-type", "")},
            "body": text_body,
            "isBase64Encoded": False,
        }
        if not _internal_compile_slots.acquire(blocking=False):
            self._send_json_response(_error_response("compiler_unavailable", 503))
            return
        try:
            response = isolated_handle_event(event)
        finally:
            _internal_compile_slots.release()
        self._send_json_response(response)


def serve_isolated_compiler() -> None:
    """Run the no-secret/no-task-role compiler service inside Fargate."""

    server = _BoundedThreadingHTTPServer(
        ("0.0.0.0", INTERNAL_COMPILER_PORT),
        _CompilerRequestHandler,
    )
    server.serve_forever()


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments != ["serve"]:
        raise SystemExit("usage: app.py serve")
    serve_isolated_compiler()
    return 0


if __name__ == "__main__":
    main()
