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
        cls.monitoring = read("monitoring.tf")
        cls.all_terraform = "\n".join(
            path.read_text(encoding="utf-8")
            for path in sorted(TERRAFORM_ROOT.glob("*.tf"))
        )
        cls.dockerfile = (SERVICE_ROOT / "Dockerfile").read_text(encoding="utf-8")
        cls.main_compact = " ".join(cls.main.split())
        cls.network_compact = " ".join(cls.network.split())
        cls.monitoring_compact = " ".join(cls.monitoring.split())

    def test_lambda_is_only_the_authenticated_forwarding_gateway(self):
        self.assertIn('command = ["app.gateway_lambda_handler"]', self.main_compact)
        self.assertIn("timeout = 45", self.main_compact)
        self.assertIn('authorization_type = "NONE"', self.main_compact)
        self.assertIn("FIRELIGHT_COMPILER_SECRET_ARN", self.main)
        self.assertIn("FIRELIGHT_INTERNAL_COMPILER_URL", self.main)
        self.assertIn('CMD ["app.gateway_lambda_handler"]', self.dockerfile)
        self.assertIn(
            "COPY docker/verify_lesson_sketches.py",
            self.dockerfile,
        )

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

    def test_monitoring_routes_alarm_and_recovery_without_subscriber_data(self):
        self.assertIn('resource "aws_sns_topic" "compiler_alerts"', self.monitoring)
        self.assertIn('resource "aws_kms_key" "compiler_alerts"', self.monitoring)
        self.assertIn("kms_master_key_id = aws_kms_key.compiler_alerts.arn", self.monitoring_compact)
        self.assertIn("enable_key_rotation = true", self.monitoring_compact)
        self.assertIn("deletion_window_in_days = 30", self.monitoring_compact)
        self.assertIn('identifiers = ["cloudwatch.amazonaws.com"]', self.monitoring_compact)
        self.assertIn('"kms:GenerateDataKey*"', self.monitoring)
        self.assertIn('"kms:Decrypt"', self.monitoring)
        self.assertIn('resource "aws_sns_topic_policy" "compiler_alerts"', self.monitoring)
        self.assertIn(
            '"SNS:ListSubscriptionsByTopic", "SNS:Publish", "SNS:SetTopicAttributes"',
            self.monitoring_compact,
        )
        self.assertIn('actions = ["SNS:Publish"]', self.monitoring_compact)
        self.assertIn('variable = "aws:SourceAccount"', self.monitoring_compact)
        self.assertIn('variable = "aws:SourceArn"', self.monitoring_compact)
        self.assertNotIn("aws_sns_topic_subscription", self.all_terraform)
        alarm_count = self.monitoring.count('resource "aws_cloudwatch_metric_alarm"')
        self.assertEqual(alarm_count, 11)
        self.assertEqual(
            self.monitoring_compact.count("alarm_actions = local.compiler_alarm_actions"),
            alarm_count,
        )
        self.assertEqual(
            self.monitoring_compact.count("ok_actions = local.compiler_alarm_actions"),
            alarm_count,
        )

    def test_monitoring_covers_gateway_ecs_and_exact_alb_target_dimensions(self):
        for metric in (
            "Url5xxCount",
            "Errors",
            "Throttles",
            "Duration",
            "RunningTaskCount",
            "CPUUtilization",
            "MemoryUtilization",
            "UnHealthyHostCount",
            "HTTPCode_Target_5XX_Count",
            "TargetConnectionErrorCount",
            "TargetResponseTime",
        ):
            with self.subTest(metric=metric):
                self.assertIn(f'metric_name = "{metric}"', self.monitoring_compact)

        self.assertIn(
            "LoadBalancer = aws_lb.compiler.arn_suffix",
            self.monitoring_compact,
        )
        self.assertIn(
            "TargetGroup = aws_lb_target_group.compiler.arn_suffix",
            self.monitoring_compact,
        )
        self.assertEqual(
            self.monitoring_compact.count('treat_missing_data = "breaching"'),
            2,
        )
        self.assertIn('resource "aws_cloudwatch_dashboard" "compiler"', self.monitoring)


if __name__ == "__main__":
    unittest.main()
