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

resource "aws_iam_role" "gateway" {
  name               = "${var.service_name}-gateway-execution"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "gateway" {
  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.gateway.arn}:*"]
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

  statement {
    sid    = "ManageVpcNetworkInterfaces"
    effect = "Allow"
    actions = [
      "ec2:AssignPrivateIpAddresses",
      "ec2:CreateNetworkInterface",
      "ec2:DeleteNetworkInterface",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DescribeSubnets",
      "ec2:UnassignPrivateIpAddresses",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "gateway" {
  name   = "${var.service_name}-gateway-runtime"
  role   = aws_iam_role.gateway.id
  policy = data.aws_iam_policy_document.gateway.json
}

data "aws_iam_policy_document" "ecs_tasks_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_execution" {
  name               = "${var.service_name}-ecs-agent"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
}

data "aws_iam_policy_document" "ecs_execution" {
  statement {
    sid       = "AuthenticateToEcr"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PullCompilerImage"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.compiler.arn]
  }

  statement {
    sid    = "WriteCompilerLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.compiler.arn}:*"]
  }
}

resource "aws_iam_role_policy" "ecs_execution" {
  name   = "${var.service_name}-ecs-agent"
  role   = aws_iam_role.ecs_execution.id
  policy = data.aws_iam_policy_document.ecs_execution.json
}
