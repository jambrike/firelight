locals {
  image_uri               = "${aws_ecr_repository.compiler.repository_url}@${var.image_digest}"
  private_subnet_ids      = aws_subnet.compiler[*].id
  compiler_container_name = "compiler"
  compiler_container_port = 8080
}

resource "aws_ecr_repository" "compiler" {
  name                 = var.service_name
  image_tag_mutability = "IMMUTABLE"

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  depends_on = [terraform_data.operator_gate]
}

# Lambda must be able to retrieve the exact same-account image after a cold or
# inactive-function restore. Own this policy in Terraform so function creation
# never relies on Lambda mutating ECR through the deploy role.
data "aws_iam_policy_document" "compiler_ecr_lambda" {
  statement {
    sid    = "LambdaECRImageRetrievalPolicy"
    effect = "Allow"
    actions = [
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values = [
        "arn:aws:lambda:eu-west-1:${var.aws_account_id}:function:${var.service_name}-gateway",
      ]
    }
  }
}

resource "aws_ecr_repository_policy" "compiler_lambda" {
  repository = aws_ecr_repository.compiler.name
  policy     = data.aws_iam_policy_document.compiler_ecr_lambda.json

  depends_on = [terraform_data.release_gate]
}

resource "aws_ecr_lifecycle_policy" "compiler" {
  repository = aws_ecr_repository.compiler.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire only abandoned untagged manifests after thirty days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 30
        }
        action = {
          type = "expire"
        }
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "gateway" {
  name              = "/aws/lambda/${var.service_name}-gateway"
  retention_in_days = var.log_retention_days

  depends_on = [terraform_data.release_gate]
}

resource "aws_cloudwatch_log_group" "compiler" {
  name              = "/ecs/${var.service_name}"
  retention_in_days = var.log_retention_days

  depends_on = [terraform_data.release_gate]
}

resource "aws_lb" "compiler" {
  name                       = substr("${var.service_name}-internal", 0, 32)
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.internal_alb.id]
  subnets                    = local.private_subnet_ids
  drop_invalid_header_fields = true
  enable_deletion_protection = var.enable_deletion_protection
  idle_timeout               = 45
  desync_mitigation_mode     = "strictest"
}

resource "aws_lb_target_group" "compiler" {
  name                 = substr("${var.service_name}-tasks", 0, 32)
  port                 = local.compiler_container_port
  protocol             = "HTTP"
  protocol_version     = "HTTP1"
  target_type          = "ip"
  vpc_id               = aws_vpc.compiler.id
  deregistration_delay = 60

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 2
    interval            = 10
    timeout             = 5
    path                = "/healthz"
    port                = "traffic-port"
    protocol            = "HTTP"
    matcher             = "200"
  }
}

resource "aws_lb_listener" "compiler" {
  load_balancer_arn = aws_lb.compiler.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.compiler.arn
  }
}

resource "aws_ecs_cluster" "compiler" {
  name = var.service_name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  depends_on = [terraform_data.release_gate]
}

resource "aws_ecs_task_definition" "compiler" {
  family                   = var.service_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  # Deliberately no task role: execution-role credentials are consumed by the
  # Fargate agent and are never made available to the compiler container.
  container_definitions = jsonencode([
    {
      name                   = local.compiler_container_name
      image                  = local.image_uri
      essential              = true
      cpu                    = 1024
      memory                 = 2048
      user                   = "1000"
      readonlyRootFilesystem = true
      entryPoint             = ["/var/lang/bin/python3"]
      command                = ["/var/task/app.py", "serve"]
      environment            = []
      secrets                = []
      stopTimeout            = 60
      portMappings = [
        {
          name          = "compiler-http"
          containerPort = local.compiler_container_port
          hostPort      = local.compiler_container_port
          protocol      = "tcp"
          appProtocol   = "http"
        },
      ]
      mountPoints = [
        {
          sourceVolume  = "compiler-tmp"
          containerPath = "/tmp"
          readOnly      = false
        },
      ]
      linuxParameters = {
        initProcessEnabled = true
        capabilities = {
          drop = ["ALL"]
        }
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.compiler.name
          "awslogs-region"        = "eu-west-1"
          "awslogs-stream-prefix" = "compiler"
        }
      }
    },
  ])

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "compiler-tmp"
  }

  depends_on = [aws_iam_role_policy.ecs_execution]
}

resource "aws_ecs_service" "compiler" {
  name             = var.service_name
  cluster          = aws_ecs_cluster.compiler.id
  task_definition  = aws_ecs_task_definition.compiler.arn
  desired_count    = var.compiler_desired_count
  platform_version = "1.4.0"

  health_check_grace_period_seconds = 60
  enable_ecs_managed_tags           = true
  enable_execute_command            = false
  propagate_tags                    = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }

  network_configuration {
    assign_public_ip = false
    security_groups  = [aws_security_group.compiler_task.id]
    subnets          = local.private_subnet_ids
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.compiler.arn
    container_name   = local.compiler_container_name
    container_port   = local.compiler_container_port
  }

  depends_on = [
    aws_lb_listener.compiler,
    aws_vpc_endpoint.ecr_api,
    aws_vpc_endpoint.ecr_dkr,
    aws_vpc_endpoint.logs,
    aws_vpc_endpoint.s3,
  ]
}

resource "aws_lambda_function" "gateway" {
  function_name = "${var.service_name}-gateway"
  description   = "Authenticated Firelight compiler gateway; never executes learner code"
  role          = aws_iam_role.gateway.arn
  package_type  = "Image"
  image_uri     = local.image_uri
  architectures = ["x86_64"]
  memory_size   = 256
  timeout       = 45
  publish       = true

  reserved_concurrent_executions = var.gateway_reserved_concurrency

  ephemeral_storage {
    size = 512
  }

  environment {
    variables = {
      FIRELIGHT_COMPILER_BUILD_ID     = var.release_build_id
      FIRELIGHT_COMPILER_ENVIRONMENT  = var.environment
      FIRELIGHT_COMPILER_IMAGE_DIGEST = var.image_digest
      FIRELIGHT_COMPILER_SECRET_ARN   = var.auth_secret_arn
      FIRELIGHT_COMPILER_SERVICE_NAME = var.service_name
      FIRELIGHT_INTERNAL_COMPILER_URL = "http://${aws_lb.compiler.dns_name}/compile"
    }
  }

  image_config {
    command = ["app.gateway_lambda_handler"]
  }

  vpc_config {
    security_group_ids = [aws_security_group.gateway.id]
    subnet_ids         = local.private_subnet_ids
  }

  logging_config {
    log_format            = "JSON"
    application_log_level = "ERROR"
    system_log_level      = "WARN"
  }

  tracing_config {
    mode = "PassThrough"
  }

  depends_on = [
    aws_cloudwatch_log_group.gateway,
    aws_ecr_repository_policy.compiler_lambda,
    aws_iam_role_policy.gateway,
    aws_vpc_endpoint.secretsmanager,
  ]
}

resource "aws_lambda_alias" "live" {
  name             = "live"
  description      = "Current immutable compiler-gateway release"
  function_name    = aws_lambda_function.gateway.function_name
  function_version = aws_lambda_function.gateway.version
}

# AuthType NONE is required because the Cloudflare Worker uses the application
# service token, not AWS credentials. Authentication happens before method/body
# processing. Deliberately omit CORS: this endpoint is server-to-server only.
resource "aws_lambda_function_url" "gateway" {
  function_name      = aws_lambda_function.gateway.function_name
  qualifier          = aws_lambda_alias.live.name
  authorization_type = "NONE"
  invoke_mode        = "BUFFERED"
}
