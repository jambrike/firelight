from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT / "scripts"))

from verify_release_config import (  # noqa: E402
    ECR_BOOTSTRAP_IMAGE_DIGEST,
    ReleaseConfigError,
    load_ecr_bootstrap_release,
    load_release,
    main,
    validate_peer,
    validate_peer_fingerprints,
)


ACCOUNTS = {"staging": "314159265358", "production": "314159265358"}
KMS_IDS = {
    "staging": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "production": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
}


def variables(environment: str) -> dict[str, object]:
    account = ACCOUNTS[environment]
    suffix = "stg" if environment == "staging" else "prd"
    role = (
        "FirelightCompilerStagingDeploy"
        if environment == "staging"
        else "FirelightCompilerProductionDeploy"
    )
    return {
        "environment": environment,
        "aws_account_id": account,
        "service_name": f"firelight-compiler-{suffix}",
        "deployment_role_name": role,
        "image_digest": f"sha256:{'a' * 64}",
        "auth_secret_arn": (
            f"arn:aws:secretsmanager:eu-west-1:{account}:"
            f"secret:firelight/{environment}/compiler-auth-AbCdEf"
        ),
        "auth_secret_kms_key_arn": None,
        "vpc_cidr": "10.42.0.0/20" if environment == "staging" else "10.43.0.0/20",
        "gateway_reserved_concurrency": 5,
        "compiler_desired_count": 2,
        "enable_deletion_protection": True,
        "log_retention_days": 14,
        "release_build_id": "c" * 40,
    }


def backend(environment: str) -> str:
    account = ACCOUNTS[environment]
    key_id = KMS_IDS[environment]
    return "\n".join(
        [
            f'bucket = "firelight-{environment}-terraform-state"',
            f'key = "firelight/compiler/{environment}/terraform.tfstate"',
            'region = "eu-west-1"',
            "encrypt = true",
            "use_lockfile = true",
            f'kms_key_id = "arn:aws:kms:eu-west-1:{account}:key/{key_id}"',
            f'allowed_account_ids = ["{account}"]',
            "",
        ]
    )


class ReleaseConfigurationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_release(
        self,
        environment: str,
        *,
        variable_overrides: dict[str, object] | None = None,
        backend_text: str | None = None,
    ) -> tuple[Path, Path]:
        backend_path = self.root / f"{environment}.backend.hcl"
        variables_path = self.root / f"{environment}.tfvars.json"
        backend_path.write_text(backend_text or backend(environment), encoding="utf-8")
        values = variables(environment)
        values.update(variable_overrides or {})
        variables_path.write_text(json.dumps(values), encoding="utf-8")
        return backend_path, variables_path

    def assert_rejected(self, code: str, callback) -> None:
        with self.assertRaisesRegex(ReleaseConfigError, f"^{code}$"):
            callback()

    def test_valid_environment_and_distinct_peer_are_ready(self):
        staging_paths = self.write_release("staging")
        production_paths = self.write_release("production")
        staging = load_release("staging", *staging_paths)
        production = load_release("production", *production_paths)
        validate_peer(staging, production)
        self.assertEqual(staging.account_id, ACCOUNTS["staging"])
        self.assertRegex(staging.backend_sha256, r"^[0-9a-f]{64}$")

    def test_cli_emits_only_identity_and_fingerprints(self):
        backend_path, variables_path = self.write_release("staging")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = main(
                [
                    "--environment",
                    "staging",
                    "--backend-config",
                    str(backend_path),
                    "--var-file",
                    str(variables_path),
                ]
            )
        rendered = output.getvalue()
        self.assertEqual(result, 0)
        self.assertIn(f"aws_account_id={ACCOUNTS['staging']}", rendered)
        self.assertNotIn("compiler-auth", rendered)
        self.assertNotIn("terraform-state", rendered)
        self.assertNotIn("10.42.0.0", rendered)
        for name in [
            "aws_account_id_sha256",
            "backend_location_sha256",
            "state_kms_key_sha256",
            "auth_secret_sha256",
            "vpc_cidr_sha256",
        ]:
            self.assertRegex(rendered, rf"{name}=[0-9a-f]{{64}}")

    def test_example_accounts_and_placeholder_digest_are_rejected(self):
        for override, code in [
            ({"aws_account_id": "123456789012"}, "AWS_ACCOUNT_ID_INVALID"),
            ({"image_digest": f"sha256:{'0' * 64}"}, "IMAGE_DIGEST_INVALID"),
            ({"release_build_id": "C" * 40}, "RELEASE_BUILD_ID_INVALID"),
        ]:
            with self.subTest(code=code):
                paths = self.write_release("staging", variable_overrides=override)
                self.assert_rejected(code, lambda: load_release("staging", *paths))

    def test_ecr_bootstrap_validator_accepts_only_the_canonical_sentinel(self):
        sentinel_paths = self.write_release(
            "staging",
            variable_overrides={"image_digest": ECR_BOOTSTRAP_IMAGE_DIGEST},
        )
        load_ecr_bootstrap_release("staging", *sentinel_paths)
        self.assert_rejected(
            "IMAGE_DIGEST_INVALID",
            lambda: load_release("staging", *sentinel_paths),
        )

        runtime_paths = self.write_release("production")
        self.assert_rejected(
            "ECR_BOOTSTRAP_IMAGE_DIGEST_INVALID",
            lambda: load_ecr_bootstrap_release("production", *runtime_paths),
        )

    def test_environment_service_role_and_secret_are_bound_together(self):
        cases = [
            ({"environment": "production"}, "ENVIRONMENT_MISMATCH"),
            ({"service_name": "firelight-compiler-prd"}, "SERVICE_NAME_INVALID"),
            ({"deployment_role_name": "Administrator"}, "DEPLOYMENT_ROLE_INVALID"),
            (
                {
                    "auth_secret_arn": (
                        f"arn:aws:secretsmanager:eu-west-1:{ACCOUNTS['staging']}:"
                        "secret:firelight/production/compiler-auth-AbCdEf"
                    )
                },
                "AUTH_SECRET_ARN_INVALID",
            ),
        ]
        for override, code in cases:
            with self.subTest(code=code):
                paths = self.write_release("staging", variable_overrides=override)
                self.assert_rejected(code, lambda: load_release("staging", *paths))

    def test_backend_is_locked_encrypted_and_account_bound(self):
        replacements = [
            ("use_lockfile = true", "use_lockfile = false", "BACKEND_LOCKING_REQUIRED"),
            ("encrypt = true", "encrypt = false", "BACKEND_ENCRYPTION_REQUIRED"),
            (
                f'allowed_account_ids = ["{ACCOUNTS["staging"]}"]',
                'allowed_account_ids = ["271828182845"]',
                "BACKEND_ACCOUNT_MISMATCH",
            ),
        ]
        for old, new, code in replacements:
            with self.subTest(code=code):
                paths = self.write_release(
                    "staging", backend_text=backend("staging").replace(old, new)
                )
                self.assert_rejected(code, lambda: load_release("staging", *paths))

    def test_backend_rejects_credentials_unknown_keys_and_symlinks(self):
        paths = self.write_release(
            "staging",
            backend_text=backend("staging") + 'access_key = "must-not-live-here"\n',
        )
        self.assert_rejected(
            "BACKEND_KEY_UNEXPECTED", lambda: load_release("staging", *paths)
        )

        real_backend, variables_path = self.write_release("staging")
        link = self.root / "linked.backend.hcl"
        link.symlink_to(real_backend)
        self.assert_rejected(
            "CONFIG_NOT_REGULAR_FILE",
            lambda: load_release("staging", link, variables_path),
        )

    def test_variable_json_rejects_duplicate_keys(self):
        backend_path, variables_path = self.write_release("staging")
        original = variables_path.read_text(encoding="utf-8")
        variables_path.write_text(
            '{"environment":"production",' + original[1:],
            encoding="utf-8",
        )
        self.assert_rejected(
            "VARIABLE_KEY_DUPLICATE",
            lambda: load_release("staging", backend_path, variables_path),
        )

    def test_runtime_safety_limits_are_required(self):
        cases = [
            ({"vpc_cidr": "8.8.0.0/20"}, "VPC_CIDR_INVALID"),
            ({"vpc_cidr": "10.42.0.0/24"}, "VPC_CIDR_INVALID"),
            ({"vpc_cidr": "10.44.0.0/20"}, "VPC_CIDR_INVALID"),
            ({"gateway_reserved_concurrency": 21}, "GATEWAY_CONCURRENCY_INVALID"),
            ({"gateway_reserved_concurrency": True}, "GATEWAY_CONCURRENCY_INVALID"),
            ({"compiler_desired_count": 1}, "COMPILER_COUNT_INVALID"),
            ({"compiler_desired_count": True}, "COMPILER_COUNT_INVALID"),
            ({"enable_deletion_protection": False}, "DELETION_PROTECTION_REQUIRED"),
            ({"log_retention_days": 365}, "LOG_RETENTION_INVALID"),
            ({"log_retention_days": True}, "LOG_RETENTION_INVALID"),
        ]
        for override, code in cases:
            with self.subTest(code=code):
                paths = self.write_release("staging", variable_overrides=override)
                self.assert_rejected(code, lambda: load_release("staging", *paths))

    def test_peer_fingerprints_reject_every_isolation_collision(self):
        staging_paths = self.write_release("staging")
        staging = load_release("staging", *staging_paths)
        production = load_release("production", *self.write_release("production"))
        staging_fingerprints = staging.isolation_fingerprints()
        production_fingerprints = production.isolation_fingerprints()
        validate_peer_fingerprints(production, staging_fingerprints)
        self.assert_rejected(
            "PEER_AWS_ACCOUNT_MISMATCH",
            lambda: validate_peer_fingerprints(
                production,
                {**staging_fingerprints, "aws_account_id_sha256": "f" * 64},
            ),
        )

        collision_codes = {
            "backend_location_sha256": "PEER_STATE_COLLISION",
            "state_kms_key_sha256": "PEER_STATE_KMS_COLLISION",
            "auth_secret_sha256": "PEER_AUTH_SECRET_COLLISION",
            "vpc_cidr_sha256": "PEER_VPC_CIDR_COLLISION",
        }
        for name, code in collision_codes.items():
            with self.subTest(name=name):
                colliding = {
                    **staging_fingerprints,
                    name: production_fingerprints[name],
                }
                self.assert_rejected(
                    code,
                    lambda colliding=colliding: validate_peer_fingerprints(
                        production, colliding
                    ),
                )

    def test_cli_requires_one_complete_unambiguous_peer_proof(self):
        backend_path, variables_path = self.write_release("production")
        base = [
            "--environment",
            "production",
            "--backend-config",
            str(backend_path),
            "--var-file",
            str(variables_path),
        ]
        self.assert_rejected(
            "PEER_FINGERPRINT_ARGUMENTS_INCOMPLETE",
            lambda: main(
                base + ["--peer-backend-location-sha256", "a" * 64]
            ),
        )

        staging_backend, staging_variables = self.write_release("staging")
        fingerprints = load_release(
            "staging", staging_backend, staging_variables
        ).isolation_fingerprints()
        fingerprint_args = [
            "--peer-aws-account-id-sha256",
            fingerprints["aws_account_id_sha256"],
            "--peer-backend-location-sha256",
            fingerprints["backend_location_sha256"],
            "--peer-state-kms-key-sha256",
            fingerprints["state_kms_key_sha256"],
            "--peer-auth-secret-sha256",
            fingerprints["auth_secret_sha256"],
            "--peer-vpc-cidr-sha256",
            fingerprints["vpc_cidr_sha256"],
        ]
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(base + fingerprint_args), 0)
        self.assert_rejected(
            "PEER_PROOF_AMBIGUOUS",
            lambda: main(
                base
                + [
                    "--peer-environment",
                    "staging",
                    "--peer-backend-config",
                    str(staging_backend),
                    "--peer-var-file",
                    str(staging_variables),
                ]
                + fingerprint_args
            ),
        )


if __name__ == "__main__":
    unittest.main()
