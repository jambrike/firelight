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

from verify_aws_identity import (  # noqa: E402
    IdentityError,
    main,
    read_identity,
    verify_identity,
)


ACCOUNT = "314159265358"
IDENTITY = {
    "Account": ACCOUNT,
    "Arn": (
        f"arn:aws:sts::{ACCOUNT}:assumed-role/"
        "FirelightCompilerStagingDeploy/github-12345"
    ),
    "UserId": "AROAABCDEFGHIJKLMNOP:github-12345",
}


class AwsIdentityTests(unittest.TestCase):
    def test_exact_short_lived_environment_role_is_accepted(self):
        result = verify_identity(
            IDENTITY,
            environment="staging",
            expected_account_id=ACCOUNT,
        )
        self.assertEqual(result["role_name"], "FirelightCompilerStagingDeploy")

    def test_root_iam_user_federated_and_wrong_role_are_rejected(self):
        arns = [
            f"arn:aws:iam::{ACCOUNT}:root",
            f"arn:aws:iam::{ACCOUNT}:user/operator",
            f"arn:aws:sts::{ACCOUNT}:federated-user/operator",
            f"arn:aws:sts::{ACCOUNT}:assumed-role/Administrator/github-12345",
            f"arn:aws:sts::{ACCOUNT}:assumed-role/FirelightCompilerProductionDeploy/github-12345",
        ]
        for arn in arns:
            with self.subTest(arn=arn), self.assertRaisesRegex(
                IdentityError,
                "^AWS_DEPLOYMENT_ROLE_REQUIRED$",
            ):
                verify_identity(
                    {**IDENTITY, "Arn": arn},
                    environment="staging",
                    expected_account_id=ACCOUNT,
                )

    def test_account_and_exact_response_shape_are_bound(self):
        with self.assertRaisesRegex(IdentityError, "^AWS_ACCOUNT_MISMATCH$"):
            verify_identity(
                IDENTITY,
                environment="staging",
                expected_account_id="271828182845",
            )
        with self.assertRaisesRegex(IdentityError, "^AWS_IDENTITY_INVALID$"):
            verify_identity(
                {**IDENTITY, "Extra": "not accepted"},
                environment="staging",
                expected_account_id=ACCOUNT,
            )

    def test_cli_emits_only_account_environment_and_role(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "identity.json"
            path.write_text(json.dumps(IDENTITY), encoding="utf-8")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                result = main(
                    [
                        str(path),
                        "--environment",
                        "staging",
                        "--expected-account-id",
                        ACCOUNT,
                    ]
                )
        self.assertEqual(result, 0)
        self.assertIn(f"aws_account_id={ACCOUNT}", output.getvalue())
        self.assertNotIn("github-12345", output.getvalue())
        self.assertNotIn("UserId", output.getvalue())

    def test_identity_json_rejects_duplicate_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "duplicate.json"
            path.write_text(
                '{"Account":"314159265358","Account":"314159265358",'
                '"Arn":"arn:aws:sts::314159265358:assumed-role/'
                'FirelightCompilerStagingDeploy/github-actions",'
                '"UserId":"AROATEST:github-actions"}',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                IdentityError,
                "^AWS_IDENTITY_KEY_DUPLICATE$",
            ):
                read_identity(path)


if __name__ == "__main__":
    unittest.main()
