from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


SERVICE_ROOT = Path(__file__).resolve().parents[1]
DOCKER_ROOT = SERVICE_ROOT / "docker"
sys.path.insert(0, str(DOCKER_ROOT))

import verify_lesson_sketches as verifier  # noqa: E402


def source_for(lesson_id: str) -> bytes:
    return f"// {lesson_id}\nvoid setup() {{}}\nvoid loop() {{}}\n".encode()


def write_fixture(root: Path) -> dict[str, object]:
    sketches: list[dict[str, object]] = []
    for lesson_id, version in verifier.EXPECTED_LESSONS:
        sketch_name = lesson_id.replace("-", "_")
        relative_path = f"{sketch_name}/{sketch_name}.ino"
        source = source_for(lesson_id)
        target = root / relative_path
        target.parent.mkdir()
        target.write_bytes(source)
        sketches.append(
            {
                "id": lesson_id,
                "version": version,
                "relativePath": relative_path,
                "sourceSha256": hashlib.sha256(source).hexdigest(),
            }
        )
    manifest: dict[str, object] = {
        "schema": verifier.FIXTURE_SCHEMA,
        "version": verifier.FIXTURE_VERSION,
        "fqbn": verifier.FQBN,
        "toolchain": {
            "arduinoCli": verifier.ARDUINO_CLI_VERSION,
            "arduinoAvrCore": verifier.ARDUINO_AVR_CORE_VERSION,
            "servo": verifier.SERVO_VERSION,
        },
        "count": len(sketches),
        "sketches": sketches,
    }
    (root / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


class LessonFixtureTests(unittest.TestCase):
    def test_loads_only_the_exact_hash_bound_six_lesson_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_fixture(root)
            fixtures = verifier.load_lesson_fixtures(root)

        self.assertEqual(
            [fixture.lesson_id for fixture in fixtures],
            [lesson_id for lesson_id, _ in verifier.EXPECTED_LESSONS],
        )
        self.assertEqual(len(fixtures), 6)
        self.assertEqual(fixtures[0].source.encode(), source_for("first-spark"))

    def test_rejects_manifest_drift_extra_fields_and_source_changes(self):
        mutations = (
            lambda manifest: manifest.update(count=5),
            lambda manifest: manifest.update(fqbn="arduino:avr:uno"),
            lambda manifest: manifest["toolchain"].update(arduinoCli="latest"),
            lambda manifest: manifest["sketches"][0].update(extra=True),
            lambda manifest: manifest["sketches"][0].update(version=True),
        )
        for mutate in mutations:
            with self.subTest(mutation=mutate), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                manifest = write_fixture(root)
                mutate(manifest)
                (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
                with self.assertRaises(verifier.VerificationError):
                    verifier.load_lesson_fixtures(root)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_fixture(root)
            (root / "first_spark" / "first_spark.ino").write_text(
                "void setup() {}\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                verifier.VerificationError,
                "LESSON_SOURCE_HASH_MISMATCH",
            ):
                verifier.load_lesson_fixtures(root)

    def test_duplicate_manifest_keys_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_fixture(root)
            (root / "manifest.json").write_text(
                '{"schema":"one","schema":"two"}',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                verifier.VerificationError,
                "MANIFEST_DUPLICATE_KEY",
            ):
                verifier.load_lesson_fixtures(root)


class ToolchainPinTests(unittest.TestCase):
    def create_toolchain(self, root: Path) -> tuple[Path, Path, Path, Path]:
        cli = root / "bin" / "arduino-cli"
        cli.parent.mkdir()
        cli.write_bytes(b"pinned-cli")
        cli.chmod(0o755)
        config = root / "opt" / "arduino" / "arduino-cli.yaml"
        config.parent.mkdir(parents=True)
        config.write_text("updater:\n  enable_notification: false\n", encoding="utf-8")
        data = root / "data"
        core = data / "packages" / "arduino" / "hardware" / "avr" / "1.8.6"
        core.mkdir(parents=True)
        (core / "platform.txt").write_text("name=Arduino AVR Boards\n", encoding="utf-8")
        (core / "boards.txt").write_text("nano.name=Arduino Nano\n", encoding="utf-8")
        libraries = root / "libraries"
        servo = libraries / "Servo"
        (servo / "src" / "avr").mkdir(parents=True)
        (servo / "library.properties").write_text(
            "name=Servo\nversion=1.3.0\narchitectures=avr,samd\n",
            encoding="utf-8",
        )
        (servo / "src" / "Servo.h").write_text("#pragma once\n", encoding="utf-8")
        (servo / "src" / "avr" / "Servo.cpp").write_text(
            "int servo_test;\n",
            encoding="utf-8",
        )
        return cli, config, data, libraries

    @staticmethod
    def version_result(version: str = "1.5.1") -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(
            args=["arduino-cli", "version"],
            returncode=0,
            stdout=(
                f"arduino-cli Version: {version} Commit: pinned Date: 2026-01-01T00:00:00Z\n"
            ).encode(),
            stderr=b"",
        )

    def test_accepts_only_cli_1_5_1_core_1_8_6_and_servo_1_3_0(self):
        with tempfile.TemporaryDirectory() as directory:
            cli, config, data, libraries = self.create_toolchain(Path(directory))
            verifier.verify_pinned_toolchain(
                cli_path=cli,
                config_path=config,
                data_root=data,
                libraries_root=libraries,
                version_runner=lambda _: self.version_result(),
            )

            with self.assertRaisesRegex(
                verifier.VerificationError,
                "ARDUINO_CLI_VERSION_MISMATCH",
            ):
                verifier.verify_pinned_toolchain(
                    cli_path=cli,
                    config_path=config,
                    data_root=data,
                    libraries_root=libraries,
                    version_runner=lambda _: self.version_result("1.5.2"),
                )

            (data / "packages" / "arduino" / "hardware" / "avr" / "9.9.9").mkdir()
            with self.assertRaisesRegex(
                verifier.VerificationError,
                "ARDUINO_CORE_VERSION_MISMATCH",
            ):
                verifier.verify_pinned_toolchain(
                    cli_path=cli,
                    config_path=config,
                    data_root=data,
                    libraries_root=libraries,
                    version_runner=lambda _: self.version_result(),
                )

    def test_rejects_changed_servo_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            cli, config, data, libraries = self.create_toolchain(Path(directory))
            (libraries / "Servo" / "library.properties").write_text(
                "name=Servo\nversion=1.3.1\narchitectures=avr,samd\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                verifier.VerificationError,
                "SERVO_VERSION_MISMATCH",
            ):
                verifier.verify_pinned_toolchain(
                    cli_path=cli,
                    config_path=config,
                    data_root=data,
                    libraries_root=libraries,
                    version_runner=lambda _: self.version_result(),
                )

    def test_compiles_each_fixture_exactly_once_and_checks_artifact_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_fixture(root)
            observed: list[str] = []

            def compile_sketch(source: str) -> object:
                observed.append(source)
                return SimpleNamespace(
                    fqbn=verifier.FQBN,
                    source_hash=hashlib.sha256(source.encode()).hexdigest(),
                    artifact_hash="a" * 64,
                    format="intel-hex",
                )

            count = verifier.verify_lesson_sketches(
                root,
                compile_fn=compile_sketch,
                toolchain_verifier=lambda: None,
            )
            self.assertEqual(count, 6)
            self.assertEqual(len(observed), 6)
            self.assertEqual(len(set(observed)), 6)

            with self.assertRaisesRegex(
                verifier.VerificationError,
                "LESSON_ARTIFACT_INVALID",
            ):
                verifier.verify_lesson_sketches(
                    root,
                    compile_fn=lambda source: SimpleNamespace(
                        fqbn="arduino:avr:uno",
                        source_hash=hashlib.sha256(source.encode()).hexdigest(),
                        artifact_hash="a" * 64,
                        format="intel-hex",
                    ),
                    toolchain_verifier=lambda: None,
                )


if __name__ == "__main__":
    unittest.main()
