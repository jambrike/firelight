locals {
  image_uri = "${aws_ecr_repository.compiler.repository_url}@${var.image_digest}"
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
}

resource "aws_ecr_lifecycle_policy" "compiler" {
  repository = aws_ecr_repository.compiler.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep the latest ten immutable compiler images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = {
          type = "expire"
        }
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "compiler" {
  name              = "/aws/lambda/${var.service_name}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "compiler" {
  name               = "${var.service_name}-execution"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "compiler" {
  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.compiler.arn}:*"]
  }

  statement {
    sid       = "ReadCompilerAuthToken"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.auth_secret_arn]
  }

  dynamic "statement" {
    for_each = var.auth_secret_kms_key_arn == null ? [] : [var.auth_secret_kms_key_arn]
    content {
      sid       = "DecryptCompilerAuthToken"
      effect    = "Allow"
      actions   = ["kms:Decrypt"]
      resources = [statement.value]
    }
  }
}

resource "aws_iam_role_policy" "compiler" {
  name   = "${var.service_name}-runtime"
  role   = aws_iam_role.compiler.id
  policy = data.aws_iam_policy_document.compiler.json
}

resource "aws_lambda_function" "compiler" {
  function_name = var.service_name
  description   = "Firelight private Arduino Nano old-bootloader compiler"
  role          = aws_iam_role.compiler.arn
  package_type  = "Image"
  image_uri     = local.image_uri
  architectures = ["x86_64"]
  memory_size   = 1024
  timeout       = 50
  publish       = true

  reserved_concurrent_executions = var.reserved_concurrency

  ephemeral_storage {
    size = 512
  }

  environment {
    variables = {
      FIRELIGHT_COMPILER_SECRET_ARN = var.auth_secret_arn
    }
  }

  image_config {
    command = ["app.lambda_handler"]
  }

  tracing_config {
    mode = "PassThrough"
  }

  depends_on = [
    aws_cloudwatch_log_group.compiler,
    aws_iam_role_policy.compiler,
  ]
}

resource "aws_lambda_alias" "live" {
  name             = "live"
  description      = "Current immutable compiler release"
  function_name    = aws_lambda_function.compiler.function_name
  function_version = aws_lambda_function.compiler.version
}

# AuthType NONE is required because the Cloudflare Worker uses the application
# service token, not AWS credentials. The handler authenticates before parsing
# any request body. Deliberately omit CORS: this endpoint is server-to-server.
resource "aws_lambda_function_url" "compiler" {
  function_name      = aws_lambda_function.compiler.function_name
  qualifier          = aws_lambda_alias.live.name
  authorization_type = "NONE"
  invoke_mode        = "BUFFERED"
}
