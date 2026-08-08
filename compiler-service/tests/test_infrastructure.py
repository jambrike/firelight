from __future__ import annotations

import unittest
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
TERRAFORM_ROOT = SERVICE_ROOT / "terraform"


def read(name: str) -> str:
    return (TERRAFORM_ROOT / name).read_text(encoding="utf-8")


class IsolationInfrastructureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.main = read("main.tf")
        cls.network = read("network.tf")
        cls.iam = read("iam.tf")
        cls.all_terraform = "\n".join(
            path.read_text(encoding="utf-8")
            for path in sorted(TERRAFORM_ROOT.glob("*.tf"))
        )
        cls.dockerfile = (SERVICE_ROOT / "Dockerfile").read_text(encoding="utf-8")
        cls.main_compact = " ".join(cls.main.split())
        cls.network_compact = " ".join(cls.network.split())

    def test_lambda_is_only_the_authenticated_forwarding_gateway(self):
        self.assertIn('command = ["app.gateway_lambda_handler"]', self.main_compact)
        self.assertIn("timeout = 45", self.main_compact)
        self.assertIn('authorization_type = "NONE"', self.main_compact)
        self.assertIn("FIRELIGHT_COMPILER_SECRET_ARN", self.main)
        self.assertIn("FIRELIGHT_INTERNAL_COMPILER_URL", self.main)
        self.assertIn('CMD ["app.gateway_lambda_handler"]', self.dockerfile)

    def test_image_installs_the_checksum_pinned_servo_library(self):
        self.assertIn("docker/install_servo_library.py", self.dockerfile)
        self.assertIn(
            "--destination /opt/arduino/libraries/Servo", self.dockerfile
        )
        self.assertIn('io.firelight.arduino-servo.version="1.3.0"', self.dockerfile)
        self.assertIn(
            'io.firelight.arduino-servo.sha256="d25b0d77f10a810d24876c570410f32c',
            self.dockerfile,
        )
        self.assertIn('VOLUME ["/tmp"]', self.dockerfile)

    def test_fargate_task_has_no_role_credentials_or_application_secrets(self):
        self.assertNotIn("task_role_arn", self.all_terraform)
        self.assertNotIn("taskRoleArn", self.all_terraform)
        self.assertIn("execution_role_arn", self.main)
        self.assertIn("environment = []", self.main_compact)
        self.assertIn("secrets = []", self.main_compact)
        self.assertIn('["/var/task/app.py", "serve"]', self.main_compact)
        self.assertIn("readonlyRootFilesystem = true", self.main_compact)
        self.assertIn('drop = ["ALL"]', self.main_compact)

        execution_policy = self.iam.split(
            'data "aws_iam_policy_document" "ecs_execution"', 1
        )[1]
        self.assertNotIn("secretsmanager:", execution_policy)
        self.assertNotIn("kms:", execution_policy)
        self.assertNotIn("s3:", execution_policy)
        self.assertIn("ecr:GetAuthorizationToken", execution_policy)
        self.assertIn("logs:PutLogEvents", execution_policy)

    def test_network_has_no_public_path_and_uses_private_service_endpoints(self):
        self.assertIn("internal = true", self.main_compact)
        self.assertIn("assign_public_ip = false", self.main_compact)
        self.assertNotIn('resource "aws_nat_gateway"', self.all_terraform)
        self.assertNotIn('resource "aws_internet_gateway"', self.all_terraform)
        self.assertNotIn("0.0.0.0/0", self.all_terraform)

        for endpoint in ("ecr_api", "ecr_dkr", "logs", "secretsmanager", "s3"):
            with self.subTest(endpoint=endpoint):
                self.assertIn(f'resource "aws_vpc_endpoint" "{endpoint}"', self.network)

    def test_security_groups_encode_gateway_to_alb_to_task_only(self):
        self.assertIn(
            "referenced_security_group_id = aws_security_group.gateway.id",
            self.network_compact,
        )
        self.assertIn(
            "referenced_security_group_id = aws_security_group.internal_alb.id",
            self.network_compact,
        )
        self.assertIn(
            "referenced_security_group_id = aws_security_group.compiler_task.id",
            self.network_compact,
        )
        self.assertIn("from_port = 8080", self.network_compact)
        self.assertIn("to_port = 8080", self.network_compact)

    def test_rollouts_drain_longer_than_the_bounded_compile_request(self):
        self.assertIn("deregistration_delay = 60", self.main_compact)
        self.assertIn("stopTimeout = 60", self.main_compact)


if __name__ == "__main__":
    unittest.main()
