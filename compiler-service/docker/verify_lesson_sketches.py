#!/usr/bin/env python3
"""Verify the pinned image toolchain and compile the six typed lesson fixtures."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable, Mapping, Sequence


FIXTURE_SCHEMA = "firelight.lesson-sketches"
FIXTURE_VERSION = 1
FQBN = "arduino:avr:nano:cpu=atmega328old"
ARDUINO_CLI_VERSION = "1.5.1"
ARDUINO_AVR_CORE_VERSION = "1.8.6"
SERVO_VERSION = "1.3.0"
EXPECTED_LESSONS = (
    ("first-spark", 1),
    ("morse-name", 1),
    ("button-reaction", 1),
    ("distance-scout", 1),
    ("servo-gate", 1),
    ("trail-rover", 1),
)
MAX_MANIFEST_BYTES = 32 * 1024
MAX_SOURCE_BYTES = 64 * 1024
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
CLI_VERSION_PATTERN = re.compile(rb"\bVersion:\s*([0-9]+\.[0-9]+\.[0-9]+)\b")


class VerificationError(Exception):
    """A bounded verifier failure safe to report without compiler output."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def fail(code: str) -> None:
    raise VerificationError(code)


@dataclass(frozen=True)
class LessonFixture:
    lesson_id: str
    version: int
    source: str
    source_sha256: str


def _unique_object(pairs: Sequence[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            fail("MANIFEST_DUPLICATE_KEY")
        value[key] = item
    return value


def _exact_keys(
    value: object,
    expected: set[str],
    code: str,
) -> Mapping[str, object]:
    if not isinstance(value, dict) or set(value) != expected:
        fail(code)
    return value


def _regular_file(path: Path, code: str) -> None:
    try:
        if path.is_symlink() or not path.is_file():
            fail(code)
    except OSError:
        fail(code)


def _read_bounded(path: Path, maximum: int, code: str) -> bytes:
    _regular_file(path, code)
    try:
        with path.open("rb") as source:
            payload = source.read(maximum + 1)
    except OSError:
        fail(code)
    if not payload or len(payload) > maximum:
        fail(code)
    return payload


def _expected_relative_path(lesson_id: str) -> str:
    sketch_name = lesson_id.replace("-", "_")
    return f"{sketch_name}/{sketch_name}.ino"


def load_lesson_fixtures(root: Path) -> tuple[LessonFixture, ...]:
    if not root.is_absolute():
        fail("FIXTURE_ROOT_INVALID")
    try:
        if root.is_symlink() or not root.is_dir():
            fail("FIXTURE_ROOT_INVALID")
        resolved_root = root.resolve(strict=True)
    except OSError:
        fail("FIXTURE_ROOT_INVALID")

    manifest_bytes = _read_bounded(
        root / "manifest.json",
        MAX_MANIFEST_BYTES,
        "MANIFEST_INVALID",
    )
    try:
        manifest = json.loads(
            manifest_bytes.decode("utf-8"),
            object_pairs_hook=_unique_object,
            parse_constant=lambda _: fail("MANIFEST_INVALID"),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
        fail("MANIFEST_INVALID")

    document = _exact_keys(
        manifest,
        {"schema", "version", "fqbn", "toolchain", "count", "sketches"},
        "MANIFEST_INVALID",
    )
    toolchain = _exact_keys(
        document["toolchain"],
        {"arduinoCli", "arduinoAvrCore", "servo"},
        "MANIFEST_TOOLCHAIN_INVALID",
    )
    if (
        document["schema"] != FIXTURE_SCHEMA
        or type(document["version"]) is not int
        or document["version"] != FIXTURE_VERSION
        or document["fqbn"] != FQBN
        or type(document["count"]) is not int
        or document["count"] != len(EXPECTED_LESSONS)
        or toolchain["arduinoCli"] != ARDUINO_CLI_VERSION
        or toolchain["arduinoAvrCore"] != ARDUINO_AVR_CORE_VERSION
        or toolchain["servo"] != SERVO_VERSION
    ):
        fail("MANIFEST_IDENTITY_MISMATCH")

    sketches = document["sketches"]
    if not isinstance(sketches, list) or len(sketches) != len(EXPECTED_LESSONS):
        fail("MANIFEST_LESSONS_INVALID")

    fixtures: list[LessonFixture] = []
    for raw_sketch, (expected_id, expected_version) in zip(
        sketches,
        EXPECTED_LESSONS,
        strict=True,
    ):
        sketch = _exact_keys(
            raw_sketch,
            {"id", "version", "relativePath", "sourceSha256"},
            "MANIFEST_LESSON_INVALID",
        )
        expected_path = _expected_relative_path(expected_id)
        if (
            sketch["id"] != expected_id
            or type(sketch["version"]) is not int
            or sketch["version"] != expected_version
            or sketch["relativePath"] != expected_path
            or not isinstance(sketch["sourceSha256"], str)
            or SHA256_PATTERN.fullmatch(sketch["sourceSha256"]) is None
        ):
            fail("MANIFEST_LESSON_INVALID")

        relative_path = PurePosixPath(expected_path)
        candidate = root.joinpath(*relative_path.parts)
        try:
            if candidate.parent.is_symlink():
                fail("LESSON_SOURCE_INVALID")
            resolved_candidate = candidate.resolve(strict=True)
            resolved_candidate.relative_to(resolved_root)
        except (OSError, ValueError):
            fail("LESSON_SOURCE_INVALID")
        source_bytes = _read_bounded(
            resolved_candidate,
            MAX_SOURCE_BYTES,
            "LESSON_SOURCE_INVALID",
        )
        if b"\x00" in source_bytes or b"\r" in source_bytes:
            fail("LESSON_SOURCE_INVALID")
        try:
            source = source_bytes.decode("utf-8")
        except UnicodeDecodeError:
            fail("LESSON_SOURCE_INVALID")
        source_sha256 = hashlib.sha256(source_bytes).hexdigest()
        if source_sha256 != sketch["sourceSha256"]:
            fail("LESSON_SOURCE_HASH_MISMATCH")
        fixtures.append(
            LessonFixture(
                lesson_id=expected_id,
                version=expected_version,
                source=source,
                source_sha256=source_sha256,
            )
        )
    return tuple(fixtures)


VersionRunner = Callable[[Sequence[str]], subprocess.CompletedProcess[bytes]]


def _run_version(command: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
    environment = {
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
    }
    try:
        return subprocess.run(
            list(command),
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
            env=environment,
        )
    except (OSError, subprocess.SubprocessError):
        fail("ARDUINO_CLI_UNAVAILABLE")


def _library_properties(path: Path) -> Mapping[str, str]:
    payload = _read_bounded(path, 16 * 1024, "SERVO_METADATA_INVALID")
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        fail("SERVO_METADATA_INVALID")
    values: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not key or key in values:
            fail("SERVO_METADATA_INVALID")
        values[key] = value.strip()
    return values


def verify_pinned_toolchain(
    *,
    cli_path: Path = Path("/usr/local/bin/arduino-cli"),
    config_path: Path = Path("/opt/arduino/arduino-cli.yaml"),
    data_root: Path = Path("/opt/arduino/data"),
    libraries_root: Path = Path("/opt/arduino/libraries"),
    version_runner: VersionRunner = _run_version,
) -> None:
    _regular_file(cli_path, "ARDUINO_CLI_UNAVAILABLE")
    _regular_file(config_path, "ARDUINO_CONFIG_INVALID")
    version = version_runner((str(cli_path), "--config-file", str(config_path), "version"))
    if (
        version.returncode != 0
        or len(version.stdout) > 4096
        or len(version.stderr) > 4096
    ):
        fail("ARDUINO_CLI_VERSION_MISMATCH")
    matches = CLI_VERSION_PATTERN.findall(version.stdout)
    if len(matches) != 1 or matches[0].decode("ascii") != ARDUINO_CLI_VERSION:
        fail("ARDUINO_CLI_VERSION_MISMATCH")

    core_root = data_root / "packages" / "arduino" / "hardware" / "avr"
    try:
        entries = tuple(core_root.iterdir())
    except OSError:
        fail("ARDUINO_CORE_VERSION_MISMATCH")
    if (
        {entry.name for entry in entries} != {ARDUINO_AVR_CORE_VERSION}
        or any(entry.is_symlink() or not entry.is_dir() for entry in entries)
    ):
        fail("ARDUINO_CORE_VERSION_MISMATCH")
    core = core_root / ARDUINO_AVR_CORE_VERSION
    _regular_file(core / "platform.txt", "ARDUINO_CORE_VERSION_MISMATCH")
    _regular_file(core / "boards.txt", "ARDUINO_CORE_VERSION_MISMATCH")

    servo_root = libraries_root / "Servo"
    try:
        if servo_root.is_symlink() or not servo_root.is_dir():
            fail("SERVO_VERSION_MISMATCH")
    except OSError:
        fail("SERVO_VERSION_MISMATCH")
    properties = _library_properties(servo_root / "library.properties")
    architectures = {
        architecture.strip()
        for architecture in properties.get("architectures", "").split(",")
        if architecture.strip()
    }
    if (
        properties.get("name") != "Servo"
        or properties.get("version") != SERVO_VERSION
        or "avr" not in architectures
    ):
        fail("SERVO_VERSION_MISMATCH")
    _regular_file(servo_root / "src" / "Servo.h", "SERVO_VERSION_MISMATCH")
    _regular_file(
        servo_root / "src" / "avr" / "Servo.cpp",
        "SERVO_VERSION_MISMATCH",
    )


CompileFunction = Callable[[str], object]
ToolchainVerifier = Callable[[], None]


def verify_lesson_sketches(
    fixture_root: Path,
    *,
    compile_fn: CompileFunction,
    toolchain_verifier: ToolchainVerifier = verify_pinned_toolchain,
) -> int:
    fixtures = load_lesson_fixtures(fixture_root)
    toolchain_verifier()
    compiled = 0
    for fixture in fixtures:
        try:
            artifact = compile_fn(fixture.source)
        except Exception:
            fail("LESSON_COMPILE_FAILED")
        if (
            getattr(artifact, "fqbn", None) != FQBN
            or getattr(artifact, "source_hash", None) != fixture.source_sha256
            or getattr(artifact, "format", None) != "intel-hex"
            or not isinstance(getattr(artifact, "artifact_hash", None), str)
            or SHA256_PATTERN.fullmatch(artifact.artifact_hash) is None
        ):
            fail("LESSON_ARTIFACT_INVALID")
        compiled += 1
    if compiled != len(EXPECTED_LESSONS):
        fail("LESSON_COUNT_MISMATCH")
    return compiled


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    args = parser.parse_args()

    from app import compile_sketch

    compiled = verify_lesson_sketches(args.root, compile_fn=compile_sketch)
    print(
        f"Verified pinned Arduino CLI {ARDUINO_CLI_VERSION}, AVR core "
        f"{ARDUINO_AVR_CORE_VERSION}, Servo {SERVO_VERSION}, and compiled "
        f"{compiled} typed lessons for {FQBN}."
    )


if __name__ == "__main__":
    try:
        main()
    except VerificationError as error:
        print(f"Lesson toolchain verification failed [{error.code}].", file=sys.stderr)
        raise SystemExit(1) from None
