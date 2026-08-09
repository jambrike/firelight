from __future__ import annotations

import copy
import hashlib
import io
import stat
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


DOCKER_ROOT = Path(__file__).resolve().parents[1] / "docker"
sys.path.insert(0, str(DOCKER_ROOT))

import verify_arduino_index as verifier  # noqa: E402
import install_servo_library as servo_installer  # noqa: E402


def reviewed_index() -> dict:
    dependencies = [
        {"packager": "arduino", "name": name, "version": version}
        for name, version in verifier.TOOLS
    ]
    tools = [
        {
            "name": name,
            "version": version,
            "systems": [{"host": "x86_64-linux-gnu", **properties}],
        }
        for (name, version), properties in verifier.TOOLS.items()
    ]
    return {
        "packages": [
            {
                "name": "arduino",
                "platforms": [
                    {
                        "architecture": "avr",
                        "version": "1.8.6",
                        "toolsDependencies": dependencies,
                        **verifier.PLATFORM,
                    }
                ],
                "tools": tools,
            }
        ]
    }


class PackageIndexPinTests(unittest.TestCase):
    def test_reviewed_platform_and_transitive_tools_are_accepted(self):
        verifier.verify(reviewed_index())

    def test_changed_core_checksum_fails_image_build(self):
        index = copy.deepcopy(reviewed_index())
        index["packages"][0]["platforms"][0]["checksum"] = "SHA-256:" + "0" * 64
        with self.assertRaises(ValueError):
            verifier.verify(index)

    def test_changed_tool_dependency_fails_image_build(self):
        index = copy.deepcopy(reviewed_index())
        index["packages"][0]["platforms"][0]["toolsDependencies"].pop()
        with self.assertRaises(ValueError):
            verifier.verify(index)

    def test_unreviewed_extra_dependency_fails_image_build(self):
        index = copy.deepcopy(reviewed_index())
        index["packages"][0]["platforms"][0]["toolsDependencies"].append(
            {"packager": "someone-else", "name": "surprise", "version": "1.0.0"}
        )
        with self.assertRaises(ValueError):
            verifier.verify(index)


def servo_archive(
    *,
    version: str = "1.3.0",
    extra_members: dict[str, bytes] | None = None,
    symlink: str | None = None,
) -> bytes:
    members = {
        "Servo-1.3.0/library.properties": (
            f"name=Servo\nversion={version}\narchitectures=avr,samd\n"
        ).encode(),
        "Servo-1.3.0/src/Servo.h": b"#pragma once\n",
        "Servo-1.3.0/src/avr/Servo.cpp": b"int servo_test;\n",
        "Servo-1.3.0/src/avr/ServoTimers.h": b"#pragma once\n",
    }
    members.update(extra_members or {})
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, payload in members.items():
            archive.writestr(name, payload)
        if symlink is not None:
            link = zipfile.ZipInfo(symlink)
            link.create_system = 3
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(link, "target")
    return output.getvalue()


def spec_for(payload: bytes) -> servo_installer.LibrarySpec:
    return servo_installer.LibrarySpec(
        name="Servo",
        version="1.3.0",
        url="https://downloads.arduino.cc/test/Servo-1.3.0.zip",
        archive_size=len(payload),
        sha256=hashlib.sha256(payload).hexdigest(),
        archive_root="Servo-1.3.0",
    )


class ServoLibraryPinTests(unittest.TestCase):
    def test_release_metadata_matches_reviewed_arduino_registry_entry(self):
        self.assertEqual(servo_installer.SERVO.version, "1.3.0")
        self.assertEqual(servo_installer.SERVO.archive_size, 133_580)
        self.assertEqual(
            servo_installer.SERVO.sha256,
            "d25b0d77f10a810d24876c570410f32cc3129f9cc3d0370c861a278b969b4b38",
        )
        self.assertEqual(
            servo_installer.SERVO.url,
            "https://downloads.arduino.cc/libraries/github.com/"
            "arduino-libraries/Servo-1.3.0.zip",
        )

    def test_verified_archive_installs_required_avr_files(self):
        payload = servo_archive()
        spec = spec_for(payload)
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "Servo"
            servo_installer.install(
                destination,
                spec=spec,
                downloader=lambda _: payload,
            )

            self.assertEqual(
                (destination / "library.properties").read_text(),
                "name=Servo\nversion=1.3.0\narchitectures=avr,samd\n",
            )
            self.assertTrue((destination / "src/Servo.h").is_file())
            self.assertTrue((destination / "src/avr/Servo.cpp").is_file())

    def test_checksum_size_and_metadata_changes_fail_closed(self):
        payload = servo_archive()
        spec = spec_for(payload)
        with self.assertRaises(ValueError):
            servo_installer.verify_payload(payload + b"x", spec)
        with self.assertRaises(ValueError):
            servo_installer.verify_payload(payload[:-1] + b"x", spec)

        changed_metadata = servo_archive(version="9.9.9")
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            servo_installer.extract(
                changed_metadata,
                Path(directory) / "Servo",
                spec_for(changed_metadata),
            )

    def test_traversal_and_symlink_members_fail_closed(self):
        traversal = servo_archive(extra_members={"Servo-1.3.0/../escape": b"no"})
        symlink = servo_archive(symlink="Servo-1.3.0/src/link")

        for payload in (traversal, symlink):
            with (
                self.subTest(kind=hashlib.sha256(payload).hexdigest()),
                tempfile.TemporaryDirectory() as directory,
                self.assertRaises(ValueError),
            ):
                servo_installer.extract(
                    payload,
                    Path(directory) / "Servo",
                    spec_for(payload),
                )

if __name__ == "__main__":
    unittest.main()
