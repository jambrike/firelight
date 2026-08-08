#!/usr/bin/env python3
"""Install one checksum-pinned Arduino Servo archive without a package index."""

from __future__ import annotations

import argparse
import hashlib
import io
import os
import stat
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable


@dataclass(frozen=True)
class LibrarySpec:
    name: str
    version: str
    url: str
    archive_size: int
    sha256: str
    archive_root: str


SERVO = LibrarySpec(
    name="Servo",
    version="1.3.0",
    url=(
        "https://downloads.arduino.cc/libraries/github.com/"
        "arduino-libraries/Servo-1.3.0.zip"
    ),
    archive_size=133_580,
    sha256="d25b0d77f10a810d24876c570410f32cc3129f9cc3d0370c861a278b969b4b38",
    archive_root="Servo-1.3.0",
)

MAX_FILES = 256
MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024
REQUIRED_FILES = {
    "library.properties",
    "src/Servo.h",
    "src/avr/Servo.cpp",
    "src/avr/ServoTimers.h",
}


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: object, **kwargs: object) -> None:
        del args, kwargs
        return None


def download(spec: LibrarySpec = SERVO) -> bytes:
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        _RejectRedirects(),
    )
    request = urllib.request.Request(
        spec.url,
        headers={"User-Agent": "firelight-reproducible-image-build/1"},
    )
    with opener.open(request, timeout=30) as response:
        if response.status != 200 or response.geturl() != spec.url:
            raise ValueError("unexpected Servo download response")
        declared_size = response.headers.get("content-length")
        if declared_size is not None and int(declared_size) != spec.archive_size:
            raise ValueError("unexpected Servo archive size")
        payload = response.read(spec.archive_size + 1)
    verify_payload(payload, spec)
    return payload


def verify_payload(payload: bytes, spec: LibrarySpec = SERVO) -> None:
    if len(payload) != spec.archive_size:
        raise ValueError("unexpected Servo archive size")
    digest = hashlib.sha256(payload).hexdigest()
    if digest != spec.sha256:
        raise ValueError("unexpected Servo archive checksum")


def _properties(payload: bytes) -> dict[str, str]:
    result: dict[str, str] = {}
    for raw_line in payload.decode("utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or not key.strip() or key.strip() in result:
            raise ValueError("invalid Servo library.properties")
        result[key.strip()] = value.strip()
    return result


def extract(payload: bytes, destination: Path, spec: LibrarySpec = SERVO) -> None:
    if destination.exists():
        raise ValueError("Servo destination already exists")

    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile:
        raise ValueError("invalid Servo ZIP archive") from None

    files: dict[str, zipfile.ZipInfo] = {}
    seen_casefolded: set[str] = set()
    uncompressed_bytes = 0
    with archive:
        for member in archive.infolist():
            if member.flag_bits & 0x1:
                raise ValueError("encrypted Servo ZIP member")
            if "\\" in member.filename or "\x00" in member.filename:
                raise ValueError("invalid Servo ZIP member path")
            member_path = PurePosixPath(member.filename)
            if (
                member_path.is_absolute()
                or ".." in member_path.parts
                or not member_path.parts
                or member_path.parts[0] != spec.archive_root
            ):
                raise ValueError("invalid Servo ZIP member path")
            relative = PurePosixPath(*member_path.parts[1:])
            if not relative.parts:
                continue
            relative_name = relative.as_posix()
            folded_name = relative_name.casefold()
            if folded_name in seen_casefolded:
                raise ValueError("duplicate Servo ZIP member")
            seen_casefolded.add(folded_name)

            mode = member.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise ValueError("symlink in Servo ZIP archive")
            if member.is_dir():
                continue
            if stat.S_IFMT(mode) not in (0, stat.S_IFREG):
                raise ValueError("non-regular Servo ZIP member")
            if member.file_size < 0:
                raise ValueError("invalid Servo ZIP member size")
            uncompressed_bytes += member.file_size
            if len(files) >= MAX_FILES or uncompressed_bytes > MAX_UNCOMPRESSED_BYTES:
                raise ValueError("Servo ZIP expansion limit exceeded")
            files[relative_name] = member

        if not REQUIRED_FILES.issubset(files):
            raise ValueError("Servo archive is missing required files")

        properties_bytes = archive.read(files["library.properties"])
        properties = _properties(properties_bytes)
        architectures = {
            value.strip() for value in properties.get("architectures", "").split(",")
        }
        if (
            properties.get("name") != spec.name
            or properties.get("version") != spec.version
            or "avr" not in architectures
        ):
            raise ValueError("unexpected Servo library metadata")

        destination.mkdir(parents=True, mode=0o755)
        try:
            for relative_name, member in sorted(files.items()):
                target = destination.joinpath(*PurePosixPath(relative_name).parts)
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                data = archive.read(member)
                if len(data) != member.file_size:
                    raise ValueError("truncated Servo ZIP member")
                descriptor = os.open(
                    target,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                    0o644,
                )
                with os.fdopen(descriptor, "wb") as output:
                    output.write(data)
        except Exception:
            for path in sorted(destination.rglob("*"), reverse=True):
                if path.is_file():
                    path.unlink()
                elif path.is_dir():
                    path.rmdir()
            destination.rmdir()
            raise


Downloader = Callable[[LibrarySpec], bytes]


def install(
    destination: Path,
    *,
    spec: LibrarySpec = SERVO,
    downloader: Downloader = download,
) -> None:
    payload = downloader(spec)
    verify_payload(payload, spec)
    extract(payload, destination, spec)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", required=True, type=Path)
    args = parser.parse_args()
    install(args.destination)


if __name__ == "__main__":
    main()
