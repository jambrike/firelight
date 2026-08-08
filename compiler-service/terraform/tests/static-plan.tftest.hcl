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

run "isolated_compiler_plan" {
  command = plan

  variables {
    image_digest    = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    auth_secret_arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:firelight/compiler-auth-test"
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
}
