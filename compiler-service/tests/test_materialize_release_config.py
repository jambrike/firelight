from __future__ import annotations

import contextlib
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT / "scripts"))

from materialize_release_config import (  # noqa: E402
    MaterializeError,
    main,
    materialize,
)
from verify_release_config import (  # noqa: E402
    ECR_BOOTSTRAP_IMAGE_DIGEST,
    ReleaseConfigError,
    load_ecr_bootstrap_release,
    load_release,
)


ACCOUNTS = {"staging": "314159265358", "production": "271828182845"}
KMS_IDS = {
    "staging": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "production": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
}


def release_environment(
    environment: str,
    *,
    secret_kms: bool = False,
) -> dict[str, str]:
    account = ACCOUNTS[environment]
    values = {
        "FIRELIGHT_COMPILER_ENVIRONMENT": environment,
        "AWS_ACCOUNT_ID": account,
        "FIRELIGHT_TERRAFORM_STATE_BUCKET": (
            f"firelight-{environment}-terraform-state"
        ),
        "FIRELIGHT_TERRAFORM_STATE_KMS_KEY_ARN": (
            f"arn:aws:kms:eu-west-1:{account}:key/{KMS_IDS[environment]}"
        ),
        "FIRELIGHT_COMPILER_IMAGE_DIGEST": f"sha256:{'a' * 64}",
        "FIRELIGHT_COMPILER_RELEASE_BUILD_ID": "c" * 40,
        "FIRELIGHT_COMPILER_AUTH_SECRET_ARN": (
            f"arn:aws:secretsmanager:eu-west-1:{account}:"
            f"secret:firelight/{environment}/compiler-auth-AbCdEf"
        ),
        "FIRELIGHT_COMPILER_AUTH_SECRET_KMS_KEY_ARN": "",
        "FIRELIGHT_COMPILER_VPC_CIDR": (
            "10.42.0.0/20" if environment == "staging" else "10.43.0.0/20"
        ),
    }
    if secret_kms:
        values["FIRELIGHT_COMPILER_AUTH_SECRET_KMS_KEY_ARN"] = (
            f"arn:aws:kms:eu-west-1:{account}:key/"
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        )
    return values


class MaterializeReleaseConfigurationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.backend_path = self.root / "release.backend.hcl"
        self.variables_path = self.root / "release.tfvars.json"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_staging_files_are_private_and_accepted_by_release_validator(self):
        materialize(
            release_environment("staging"),
            self.backend_path,
            self.variables_path,
        )

        release = load_release("staging", self.backend_path, self.variables_path)
        variables = json.loads(self.variables_path.read_text(encoding="utf-8"))
        self.assertEqual(release.account_id, ACCOUNTS["staging"])
        self.assertEqual(variables["service_name"], "firelight-compiler-stg")
        self.assertEqual(
            variables["deployment_role_name"],
            "FirelightCompilerStagingDeploy",
        )
        self.assertIsNone(variables["auth_secret_kms_key_arn"])
        self.assertEqual(
            stat.S_IMODE(self.backend_path.stat().st_mode),
            0o600,
        )
        self.assertEqual(
            stat.S_IMODE(self.variables_path.stat().st_mode),
            0o600,
        )

    def test_optional_secret_kms_key_is_materialized_and_validated(self):
        environment = release_environment("staging", secret_kms=True)
        materialize(environment, self.backend_path, self.variables_path)

        variables = json.loads(self.variables_path.read_text(encoding="utf-8"))
        self.assertEqual(
            variables["auth_secret_kms_key_arn"],
            environment["FIRELIGHT_COMPILER_AUTH_SECRET_KMS_KEY_ARN"],
        )
        load_release("staging", self.backend_path, self.variables_path)

    def test_ecr_bootstrap_derives_only_the_canonical_sentinel(self):
        environment = release_environment("staging")
        del environment["FIRELIGHT_COMPILER_IMAGE_DIGEST"]
        materialize(
            environment,
            self.backend_path,
            self.variables_path,
            ecr_bootstrap=True,
        )

        variables = json.loads(self.variables_path.read_text(encoding="utf-8"))
        self.assertEqual(
            variables["image_digest"],
            ECR_BOOTSTRAP_IMAGE_DIGEST,
        )
        load_ecr_bootstrap_release(
            "staging",
            self.backend_path,
            self.variables_path,
        )
        with self.assertRaisesRegex(ReleaseConfigError, "^IMAGE_DIGEST_INVALID$"):
            load_release("staging", self.backend_path, self.variables_path)

    def test_ecr_bootstrap_rejects_any_non_sentinel_digest(self):
        environment = release_environment("staging")
        with self.assertRaisesRegex(
            MaterializeError,
            "^ECR_BOOTSTRAP_IMAGE_DIGEST_INVALID$",
        ):
            materialize(
                environment,
                self.backend_path,
                self.variables_path,
                ecr_bootstrap=True,
            )
        self.assertFalse(self.backend_path.exists())
        self.assertFalse(self.variables_path.exists())

    def test_production_derives_only_the_canonical_role_service_and_state_key(self):
        materialize(
            release_environment("production"),
            self.backend_path,
            self.variables_path,
        )

        variables = json.loads(self.variables_path.read_text(encoding="utf-8"))
        backend = self.backend_path.read_text(encoding="utf-8")
        self.assertEqual(variables["service_name"], "firelight-compiler-prd")
        self.assertEqual(
            variables["deployment_role_name"],
            "FirelightCompilerProductionDeploy",
        )
        self.assertIn(
            'key = "firelight/compiler/production/terraform.tfstate"',
            backend,
        )
        load_release("production", self.backend_path, self.variables_path)

    def test_paths_must_be_absolute_distinct_and_outside_symlink_parents(self):
        environment = release_environment("staging")
        cases = [
            (
                Path("relative.backend.hcl"),
                self.variables_path,
                "OUTPUT_PATH_INVALID",
            ),
            (self.backend_path, self.backend_path, "OUTPUT_PATH_COLLISION"),
        ]
        for backend_path, variables_path, code in cases:
            with self.subTest(code=code):
                with self.assertRaisesRegex(MaterializeError, f"^{code}$"):
                    materialize(environment, backend_path, variables_path)

        real_parent = self.root / "real"
        real_parent.mkdir()
        linked_parent = self.root / "linked"
        linked_parent.symlink_to(real_parent, target_is_directory=True)
        with self.assertRaisesRegex(MaterializeError, "^OUTPUT_PARENT_INVALID$"):
            materialize(
                environment,
                linked_parent / "backend.hcl",
                self.root / "unused.tfvars.json",
            )

    def test_existing_target_is_never_overwritten(self):
        sentinel = "retain-this-file\n"
        self.variables_path.write_text(sentinel, encoding="utf-8")

        with self.assertRaisesRegex(MaterializeError, "^OUTPUT_ALREADY_EXISTS$"):
            materialize(
                release_environment("staging"),
                self.backend_path,
                self.variables_path,
            )

        self.assertEqual(
            self.variables_path.read_text(encoding="utf-8"),
            sentinel,
        )
        self.assertFalse(self.backend_path.exists())

    def test_invalid_input_creates_no_files(self):
        cases = [
            ({}, "INVALID_FIRELIGHT_COMPILER_ENVIRONMENT"),
            (
                {
                    **release_environment("staging"),
                    "AWS_ACCOUNT_ID": "123456789012",
                },
                "AWS_ACCOUNT_ID_INVALID",
            ),
            (
                {
                    **release_environment("staging"),
                    "FIRELIGHT_COMPILER_IMAGE_DIGEST": f"sha256:{'0' * 64}",
                },
                "IMAGE_DIGEST_INVALID",
            ),
        ]
        for index, (environment, code) in enumerate(cases):
            with self.subTest(code=code):
                backend_path = self.root / f"{index}.backend.hcl"
                variables_path = self.root / f"{index}.tfvars.json"
                with self.assertRaisesRegex(
                    (MaterializeError, ValueError),
                    f"^{code}$",
                ):
                    materialize(environment, backend_path, variables_path)
                self.assertFalse(backend_path.exists())
                self.assertFalse(variables_path.exists())

    def test_second_file_failure_removes_the_first_file(self):
        real_open = os.open
        call_count = 0

        def fail_second_open(path, flags, mode=0o777, *, dir_fd=None):
            nonlocal call_count
            call_count += 1
            if call_count == 2:
                raise OSError("simulated write failure")
            return real_open(path, flags, mode, dir_fd=dir_fd)

        with mock.patch("materialize_release_config.os.open", fail_second_open):
            with self.assertRaisesRegex(MaterializeError, "^OUTPUT_WRITE_FAILED$"):
                materialize(
                    release_environment("staging"),
                    self.backend_path,
                    self.variables_path,
                )

        self.assertFalse(self.backend_path.exists())
        self.assertFalse(self.variables_path.exists())

    def test_cli_output_is_fixed_and_contains_no_release_input(self):
        environment = release_environment("staging", secret_kms=True)
        output = io.StringIO()
        with mock.patch.dict(os.environ, environment, clear=True):
            with contextlib.redirect_stdout(output):
                result = main(
                    [
                        "--backend-output",
                        str(self.backend_path),
                        "--variables-output",
                        str(self.variables_path),
                    ]
                )

        rendered = output.getvalue()
        self.assertEqual(result, 0)
        self.assertEqual(
            rendered,
            "compiler_release_configuration_materialized=true\n",
        )
        for value in environment.values():
            if value:
                self.assertNotIn(value, rendered)

    def test_ecr_bootstrap_cli_has_an_explicit_fixed_success_marker(self):
        environment = release_environment("staging")
        environment["FIRELIGHT_COMPILER_IMAGE_DIGEST"] = ""
        output = io.StringIO()
        with mock.patch.dict(os.environ, environment, clear=True):
            with contextlib.redirect_stdout(output):
                result = main(
                    [
                        "--ecr-bootstrap",
                        "--backend-output",
                        str(self.backend_path),
                        "--variables-output",
                        str(self.variables_path),
                    ]
                )

        self.assertEqual(result, 0)
        self.assertEqual(
            output.getvalue(),
            "compiler_ecr_bootstrap_configuration_materialized=true\n",
        )


if __name__ == "__main__":
    unittest.main()
