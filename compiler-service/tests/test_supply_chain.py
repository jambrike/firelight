from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path


DOCKER_ROOT = Path(__file__).resolve().parents[1] / "docker"
sys.path.insert(0, str(DOCKER_ROOT))

import verify_arduino_index as verifier  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
