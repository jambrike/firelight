"""Build-only downloader that verifies and installs one Arduino CLI binary."""

from __future__ import annotations

import argparse
import hashlib
import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path


MAX_ARCHIVE_BYTES = 128 * 1024 * 1024


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--destination", required=True, type=Path)
    args = parser.parse_args()

    if not args.version.replace(".", "").isdigit():
        raise SystemExit("invalid version")
    if len(args.sha256) != 64 or any(c not in "0123456789abcdef" for c in args.sha256):
        raise SystemExit("invalid checksum")

    filename = f"arduino-cli_{args.version}_Linux_64bit.tar.gz"
    url = (
        "https://github.com/arduino/arduino-cli/releases/download/"
        f"v{args.version}/{filename}"
    )

    with tempfile.TemporaryDirectory(prefix="arduino-cli-install-") as directory:
        archive = Path(directory) / filename
        digest = hashlib.sha256()
        request = urllib.request.Request(url, headers={"User-Agent": "firelight-image-build"})
        with urllib.request.urlopen(request, timeout=30) as response, archive.open("wb") as output:
            downloaded = 0
            while chunk := response.read(1024 * 1024):
                downloaded += len(chunk)
                if downloaded > MAX_ARCHIVE_BYTES:
                    raise SystemExit("Arduino CLI archive exceeds build limit")
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != args.sha256:
            raise SystemExit("Arduino CLI checksum mismatch")

        with tarfile.open(archive, "r:gz") as tar:
            members = [
                member
                for member in tar.getmembers()
                if member.isfile() and Path(member.name).name == "arduino-cli"
            ]
            if len(members) != 1:
                raise SystemExit("Arduino CLI archive layout is invalid")
            if members[0].size > MAX_ARCHIVE_BYTES:
                raise SystemExit("Arduino CLI binary exceeds build limit")
            source = tar.extractfile(members[0])
            if source is None:
                raise SystemExit("Arduino CLI binary is missing")
            args.destination.parent.mkdir(parents=True, exist_ok=True)
            with args.destination.open("wb") as target:
                shutil.copyfileobj(source, target)
            args.destination.chmod(0o755)


if __name__ == "__main__":
    main()
