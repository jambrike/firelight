mock_provider "aws" {
  override_during = plan
}

override_data {
  target = data.aws_availability_zones.available
  values = {
    names    = ["eu-west-1a", "eu-west-1b"]
    zone_ids = ["euw1-az1", "euw1-az2"]
  }
}

override_data {
  target = data.aws_caller_identity.current
  values = {
    account_id = "999999999999"
    arn        = "arn:aws:sts::999999999999:assumed-role/FirelightCompilerStagingDeploy/terraform-test"
    user_id    = "AROATEST:terraform-test"
  }
}

override_data {
  target = data.aws_partition.current
  values = {
    partition  = "aws"
    dns_suffix = "amazonaws.com"
  }
}

# Resource identifiers are provider-computed. Pin the identifiers that flow
# through monitoring dimensions and actions so the mock plan can prove their
# exact wiring without applying anything.
override_resource {
  target          = aws_kms_key.compiler_alerts
  override_during = plan
  values = {
    arn    = "arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111"
    key_id = "11111111-1111-1111-1111-111111111111"
  }
}

override_resource {
  target          = aws_sns_topic.compiler_alerts
  override_during = plan
  values = {
    arn = "arn:aws:sns:eu-west-1:123456789012:firelight-compiler-alerts"
  }
}

override_resource {
  target          = aws_lb.compiler
  override_during = plan
  values = {
    arn        = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:loadbalancer/app/firelight-compiler/1111111111111111"
    arn_suffix = "app/firelight-compiler/1111111111111111"
  }
}

override_resource {
  target          = aws_lb_target_group.compiler
  override_during = plan
  values = {
    arn        = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup/firelight-compiler/2222222222222222"
    arn_suffix = "targetgroup/firelight-compiler/2222222222222222"
  }
}

# Mock providers synthesize arbitrary strings for computed policy-document JSON.
# Override each document with valid JSON so the AWS resource schema validators
# can exercise the plan without credentials or remote API calls.
override_data {
  target = data.aws_iam_policy_document.lambda_assume_role
  values = { json = "{}" }
}

override_data {
  target = data.aws_iam_policy_document.gateway
  values = { json = "{}" }
}

override_data {
  target = data.aws_iam_policy_document.ecs_tasks_assume_role
  values = { json = "{}" }
}

override_data {
  target = data.aws_iam_policy_document.ecs_execution
  values = { json = "{}" }
}

override_data {
  target = data.aws_iam_policy_document.compiler_ecr_lambda
  values = { json = "{}" }
}

override_data {
  target = data.aws_iam_policy_document.ecr_endpoint
  values = { json = "{}" }
}

override_data {
  target = data.aws_iam_policy_document.logs_endpoint
  values = { json = "{}" }
}

override_data {
  target = data.aws_iam_policy_document.secretsmanager_endpoint
  values = { json = "{}" }
}

override_data {
  target = data.aws_iam_policy_document.s3_endpoint
  values = { json = "{}" }
}

override_data {
  target = data.aws_iam_policy_document.compiler_alerts_kms
  values = { json = "{}" }
}

override_data {
  target = data.aws_iam_policy_document.compiler_alerts_topic
  values = { json = "{}" }
}

run "targeted_ecr_bootstrap_plan" {
  command = plan

  variables {
    environment          = "staging"
    aws_account_id       = "999999999999"
    service_name         = "firelight-compiler-stg"
    deployment_role_name = "FirelightCompilerStagingDeploy"
    image_digest         = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    release_build_id     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    auth_secret_arn      = "arn:aws:secretsmanager:eu-west-1:999999999999:secret:firelight/compiler-auth-test"
  }

  plan_options {
    target = [
      aws_ecr_repository.compiler,
      aws_ecr_lifecycle_policy.compiler,
    ]
  }

  assert {
    condition     = aws_ecr_repository.compiler.name == "firelight-compiler-stg"
    error_message = "The sentinel may plan only the canonical targeted ECR bootstrap."
  }
}

run "targeted_ecr_bootstrap_rejects_noncanonical_repository" {
  command = plan

  variables {
    environment          = "staging"
    aws_account_id       = "999999999999"
    service_name         = "firelight-compiler-bad"
    deployment_role_name = "FirelightCompilerStagingDeploy"
    image_digest         = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    release_build_id     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    auth_secret_arn      = "arn:aws:secretsmanager:eu-west-1:999999999999:secret:firelight/compiler-auth-test"
  }

  plan_options {
    target = [
      aws_ecr_repository.compiler,
      aws_ecr_lifecycle_policy.compiler,
    ]
  }

  expect_failures = [terraform_data.operator_gate]
}

run "complete_plan_rejects_ecr_bootstrap_sentinel" {
  command = plan

  variables {
    environment          = "staging"
    aws_account_id       = "999999999999"
    service_name         = "firelight-compiler-stg"
    deployment_role_name = "FirelightCompilerStagingDeploy"
    image_digest         = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    release_build_id     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    auth_secret_arn      = "arn:aws:secretsmanager:eu-west-1:999999999999:secret:firelight/compiler-auth-test"
  }

  expect_failures = [terraform_data.release_gate]
}

run "isolated_compiler_plan" {
  command = plan

  variables {
    environment          = "staging"
    aws_account_id       = "999999999999"
    service_name         = "firelight-compiler-stg"
    deployment_role_name = "FirelightCompilerStagingDeploy"
    image_digest         = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    release_build_id     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    auth_secret_arn      = "arn:aws:secretsmanager:eu-west-1:999999999999:secret:firelight/compiler-auth-test"
  }

  assert {
    condition     = length(aws_subnet.compiler) == 2
    error_message = "The compiler must span exactly two private subnets."
  }

  assert {
    condition     = aws_lb.compiler.internal
    error_message = "The compiler load balancer must remain private."
  }

  assert {
    condition     = aws_ecs_task_definition.compiler.network_mode == "awsvpc"
    error_message = "Fargate tasks must keep isolated awsvpc networking."
  }

  assert {
    condition     = aws_ecs_service.compiler.network_configuration[0].assign_public_ip == false
    error_message = "Compiler tasks must never receive public IP addresses."
  }

  assert {
    condition     = aws_ecs_service.compiler.desired_count == 2
    error_message = "The compiler must retain its two-task availability default."
  }

  assert {
    condition     = aws_lb.compiler.enable_deletion_protection
    error_message = "The long-lived internal load balancer must keep deletion protection."
  }

  assert {
    condition     = aws_lambda_function.gateway.reserved_concurrent_executions == 5
    error_message = "The gateway concurrency default must remain bounded."
  }

  assert {
    condition     = aws_lambda_function.gateway.timeout == 45
    error_message = "The public compiler gateway must retain its 45-second deadline."
  }

  assert {
    condition     = aws_ecr_repository_policy.compiler_lambda.repository == aws_ecr_repository.compiler.name
    error_message = "The exact Lambda image retrieval policy must remain attached to the compiler repository."
  }

  assert {
    condition = (
      aws_sns_topic.compiler_alerts.kms_master_key_id == aws_kms_key.compiler_alerts.arn &&
      aws_kms_key.compiler_alerts.enable_key_rotation &&
      aws_kms_key.compiler_alerts.deletion_window_in_days == 30 &&
      aws_kms_alias.compiler_alerts.name == "alias/firelight-compiler-stg-alerts"
    )
    error_message = "Compiler alerts must use a rotating customer-managed key with a recovery window."
  }

  assert {
    condition = alltrue([
      contains(aws_cloudwatch_metric_alarm.gateway_url_5xx.alarm_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.gateway_errors.alarm_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.gateway_throttles.alarm_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.gateway_duration.alarm_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.ecs_running_tasks.alarm_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.ecs_cpu.alarm_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.ecs_memory.alarm_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.alb_unhealthy_targets.alarm_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.alb_target_5xx.alarm_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.alb_connection_errors.alarm_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.alb_latency.alarm_actions, aws_sns_topic.compiler_alerts.arn),
    ])
    error_message = "Every compiler alarm must route ALARM notifications to the encrypted topic."
  }

  assert {
    condition = alltrue([
      contains(aws_cloudwatch_metric_alarm.gateway_url_5xx.ok_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.gateway_errors.ok_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.gateway_throttles.ok_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.gateway_duration.ok_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.ecs_running_tasks.ok_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.ecs_cpu.ok_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.ecs_memory.ok_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.alb_unhealthy_targets.ok_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.alb_target_5xx.ok_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.alb_connection_errors.ok_actions, aws_sns_topic.compiler_alerts.arn),
      contains(aws_cloudwatch_metric_alarm.alb_latency.ok_actions, aws_sns_topic.compiler_alerts.arn),
    ])
    error_message = "Every compiler alarm must route recovery notifications to the encrypted topic."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.gateway_url_5xx.metric_name == "Url5xxCount" &&
      aws_cloudwatch_metric_alarm.gateway_url_5xx.dimensions["Resource"] == "${aws_lambda_function.gateway.function_name}:${aws_lambda_alias.live.name}" &&
      aws_cloudwatch_metric_alarm.gateway_duration.threshold == 40000 &&
      aws_cloudwatch_metric_alarm.gateway_duration.statistic == "Maximum"
    )
    error_message = "Gateway alarms must cover Function URL 5xx and the approach to the fixed timeout."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.ecs_running_tasks.namespace == "ECS/ContainerInsights" &&
      aws_cloudwatch_metric_alarm.ecs_running_tasks.threshold == var.compiler_desired_count &&
      aws_cloudwatch_metric_alarm.ecs_running_tasks.treat_missing_data == "breaching" &&
      aws_cloudwatch_metric_alarm.ecs_cpu.threshold == 90 &&
      aws_cloudwatch_metric_alarm.ecs_memory.threshold == 85
    )
    error_message = "ECS alarms must cover task loss, including absent metrics, and sustained resource pressure."
  }

  assert {
    condition = alltrue([
      aws_cloudwatch_metric_alarm.alb_unhealthy_targets.dimensions["LoadBalancer"] == aws_lb.compiler.arn_suffix,
      aws_cloudwatch_metric_alarm.alb_unhealthy_targets.dimensions["TargetGroup"] == aws_lb_target_group.compiler.arn_suffix,
      aws_cloudwatch_metric_alarm.alb_unhealthy_targets.treat_missing_data == "breaching",
      aws_cloudwatch_metric_alarm.alb_target_5xx.metric_name == "HTTPCode_Target_5XX_Count",
      aws_cloudwatch_metric_alarm.alb_connection_errors.metric_name == "TargetConnectionErrorCount",
      aws_cloudwatch_metric_alarm.alb_latency.metric_name == "TargetResponseTime",
      aws_cloudwatch_metric_alarm.alb_latency.threshold == 35,
    ])
    error_message = "ALB alarms must use the exact load-balancer/target-group dimensions and bounded thresholds."
  }

  assert {
    condition     = aws_cloudwatch_dashboard.compiler.dashboard_name == "firelight-compiler-stg-operations"
    error_message = "The compiler operational dashboard must keep its stable environment-local name."
  }
}
