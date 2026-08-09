import importlib.util
import unittest
from pathlib import Path


SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "report_terraform_failure.py"
)
SPEC = importlib.util.spec_from_file_location("report_terraform_failure", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class TerraformFailureReportTests(unittest.TestCase):
    def test_extracts_errors_and_redacts_protected_values(self):
        output = MODULE.safe_summary(
            "\x1b[31m│ Error: request failed for "
            "arn:aws:secretsmanager:eu-west-1:123456789012:secret:private-value\x1b[0m\n"
            "│ with aws_lambda_function.gateway,\n"
            "│ token=abcdefghijklmnopqrstuvwxyz0123456789SECRET\n"
        )

        rendered = "\n".join(output)
        self.assertIn("Error: request failed", rendered)
        self.assertIn("aws_lambda_function.gateway", rendered)
        self.assertIn("[AWS_ARN]", rendered)
        self.assertIn("token=[REDACTED]", rendered)
        self.assertNotIn("123456789012", rendered)
        self.assertNotIn("private-value", rendered)
        self.assertNotIn("abcdefghijklmnopqrstuvwxyz", rendered)

    def test_returns_a_generic_message_without_an_error_block(self):
        self.assertEqual(
            MODULE.safe_summary("provider exited unexpectedly\n"),
            ["Terraform failed without a safe diagnostic summary."],
        )


if __name__ == "__main__":
    unittest.main()
