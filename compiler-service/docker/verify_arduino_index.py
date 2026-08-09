"""Fail an image build if Arduino's index no longer matches reviewed pins."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


PLATFORM = {
    "archiveFileName": "avr-1.8.6.tar.bz2",
    "checksum": "SHA-256:ff1d17274b5a952f172074bd36c3924336baefded0232e10982f8999c2f7c3b6",
    "size": "7127080",
    "url": "https://downloads.arduino.cc/cores/staging/avr-1.8.6.tar.bz2",
}

TOOLS = {
    ("arduinoOTA", "1.3.0"): {
        "archiveFileName": "arduinoOTA-1.3.0-linux_amd64.tar.bz2",
        "checksum": "SHA-256:aa45ee2441ffc3a122daec5802941d1fa2ac47adf5c5c481b5e0daa4dc259ffa",
        "size": "2716248",
        "url": "https://downloads.arduino.cc/tools/arduinoOTA-1.3.0-linux_amd64.tar.bz2",
    },
    ("avr-gcc", "7.3.0-atmel3.6.1-arduino7"): {
        "archiveFileName": "avr-gcc-7.3.0-atmel3.6.1-arduino7-x86_64-pc-linux-gnu.tar.bz2",
        "checksum": "SHA-256:bd8c37f6952a2130ac9ee32c53f6a660feb79bee8353c8e289eb60fdcefed91e",
        "size": "37630618",
        "url": (
            "https://downloads.arduino.cc/tools/"
            "avr-gcc-7.3.0-atmel3.6.1-arduino7-x86_64-pc-linux-gnu.tar.bz2"
        ),
    },
    ("avrdude", "6.3.0-arduino17"): {
        "archiveFileName": "avrdude-6.3.0-arduino17-x86_64-pc-linux-gnu.tar.bz2",
        "checksum": "SHA-256:accdfb920af2aabf4f7461d2ac73c0751760f525216dc4e7657427a78c60d13d",
        "size": "254271",
        "url": (
            "https://downloads.arduino.cc/tools/"
            "avrdude-6.3.0-arduino17-x86_64-pc-linux-gnu.tar.bz2"
        ),
    },
}


def _arduino_package(index: dict[str, Any]) -> dict[str, Any]:
    packages = [
        package for package in index.get("packages", []) if package.get("name") == "arduino"
    ]
    if len(packages) != 1:
        raise ValueError("Arduino package index entry is missing or duplicated")
    return packages[0]


def _require_properties(actual: dict[str, Any], expected: dict[str, str]) -> None:
    for key, expected_value in expected.items():
        if str(actual.get(key)) != expected_value:
            raise ValueError(f"reviewed Arduino pin changed: {key}")


def verify(index: dict[str, Any]) -> None:
    package = _arduino_package(index)
    platforms = [
        platform
        for platform in package.get("platforms", [])
        if platform.get("architecture") == "avr" and platform.get("version") == "1.8.6"
    ]
    if len(platforms) != 1:
        raise ValueError("Arduino AVR 1.8.6 index entry is missing or duplicated")
    platform = platforms[0]
    _require_properties(platform, PLATFORM)

    dependency_entries = [
        (
            dependency.get("packager"),
            dependency.get("name"),
            dependency.get("version"),
        )
        for dependency in platform.get("toolsDependencies", [])
    ]
    expected_dependencies = {("arduino", name, version) for name, version in TOOLS}
    if (
        len(dependency_entries) != len(expected_dependencies)
        or set(dependency_entries) != expected_dependencies
    ):
        raise ValueError("Arduino AVR 1.8.6 tool dependencies changed")

    for identity, expected in TOOLS.items():
        tools = [
            tool
            for tool in package.get("tools", [])
            if (tool.get("name"), tool.get("version")) == identity
        ]
        if len(tools) != 1:
            raise ValueError(f"Arduino tool index entry is missing or duplicated: {identity}")
        systems = [
            system
            for system in tools[0].get("systems", [])
            if system.get("host") == "x86_64-linux-gnu"
        ]
        if len(systems) != 1:
            raise ValueError(f"Arduino linux/amd64 tool entry is missing: {identity}")
        _require_properties(systems[0], expected)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: verify_arduino_index.py PACKAGE_INDEX_JSON")
    with Path(sys.argv[1]).open("rb") as source:
        index = json.load(source)
    if not isinstance(index, dict):
        raise SystemExit("Arduino package index root is invalid")
    try:
        verify(index)
    except ValueError as error:
        raise SystemExit(str(error)) from None


if __name__ == "__main__":
    main()
