data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

resource "aws_vpc" "compiler" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${var.service_name}-isolated"
  }
}

resource "aws_subnet" "compiler" {
  count = 2

  vpc_id                  = aws_vpc.compiler.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = false

  tags = {
    Name = "${var.service_name}-private-${count.index + 1}"
  }
}

resource "aws_route_table" "compiler" {
  count = 2

  vpc_id = aws_vpc.compiler.id

  # There is intentionally no internet-gateway or NAT default route.
  tags = {
    Name = "${var.service_name}-private-${count.index + 1}"
  }
}

resource "aws_route_table_association" "compiler" {
  count = 2

  subnet_id      = aws_subnet.compiler[count.index].id
  route_table_id = aws_route_table.compiler[count.index].id
}

resource "aws_security_group" "gateway" {
  name        = "${var.service_name}-gateway"
  description = "Lambda gateway: internal ALB and Secrets Manager endpoint only"
  vpc_id      = aws_vpc.compiler.id
}

resource "aws_security_group" "internal_alb" {
  name        = "${var.service_name}-internal-alb"
  description = "Internal ALB: accepts only the compiler gateway"
  vpc_id      = aws_vpc.compiler.id
}

resource "aws_security_group" "compiler_task" {
  name        = "${var.service_name}-task"
  description = "Compiler tasks: accepts only the internal ALB"
  vpc_id      = aws_vpc.compiler.id
}

resource "aws_security_group" "interface_endpoints" {
  name        = "${var.service_name}-endpoints"
  description = "Private AWS API endpoints used by the gateway and Fargate agent"
  vpc_id      = aws_vpc.compiler.id
}

resource "aws_vpc_security_group_egress_rule" "gateway_to_alb" {
  security_group_id            = aws_security_group.gateway.id
  referenced_security_group_id = aws_security_group.internal_alb.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  description                  = "Forward authenticated requests to the internal ALB"
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_gateway" {
  security_group_id            = aws_security_group.internal_alb.id
  referenced_security_group_id = aws_security_group.gateway.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  description                  = "Only the Lambda gateway may reach the internal listener"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id            = aws_security_group.internal_alb.id
  referenced_security_group_id = aws_security_group.compiler_task.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  description                  = "Forward requests and health checks to compiler tasks"
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.compiler_task.id
  referenced_security_group_id = aws_security_group.internal_alb.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  description                  = "Only the internal ALB may reach compiler HTTP"
}

resource "aws_vpc_security_group_egress_rule" "gateway_to_endpoints" {
  security_group_id            = aws_security_group.gateway.id
  referenced_security_group_id = aws_security_group.interface_endpoints.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "Read the service token through the private endpoint"
}

resource "aws_vpc_security_group_egress_rule" "tasks_to_endpoints" {
  security_group_id            = aws_security_group.compiler_task.id
  referenced_security_group_id = aws_security_group.interface_endpoints.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "Fargate-agent image pull and log delivery endpoints"
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_gateway" {
  security_group_id            = aws_security_group.interface_endpoints.id
  referenced_security_group_id = aws_security_group.gateway.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "Private API calls from the gateway"
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_tasks" {
  security_group_id            = aws_security_group.interface_endpoints.id
  referenced_security_group_id = aws_security_group.compiler_task.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "Private API calls from the Fargate agent"
}

data "aws_iam_policy_document" "ecr_endpoint" {
  statement {
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.compiler.arn]
  }
}

resource "aws_vpc_endpoint" "ecr_api" {
  vpc_id              = aws_vpc.compiler.id
  service_name        = "com.amazonaws.eu-west-1.ecr.api"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = local.private_subnet_ids
  security_group_ids  = [aws_security_group.interface_endpoints.id]
  policy              = data.aws_iam_policy_document.ecr_endpoint.json
}

resource "aws_vpc_endpoint" "ecr_dkr" {
  vpc_id              = aws_vpc.compiler.id
  service_name        = "com.amazonaws.eu-west-1.ecr.dkr"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = local.private_subnet_ids
  security_group_ids  = [aws_security_group.interface_endpoints.id]
  policy              = data.aws_iam_policy_document.ecr_endpoint.json
}

data "aws_iam_policy_document" "logs_endpoint" {
  statement {
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${aws_cloudwatch_log_group.gateway.arn}:*",
      "${aws_cloudwatch_log_group.compiler.arn}:*",
    ]
  }
}

resource "aws_vpc_endpoint" "logs" {
  vpc_id              = aws_vpc.compiler.id
  service_name        = "com.amazonaws.eu-west-1.logs"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = local.private_subnet_ids
  security_group_ids  = [aws_security_group.interface_endpoints.id]
  policy              = data.aws_iam_policy_document.logs_endpoint.json
}

data "aws_iam_policy_document" "secretsmanager_endpoint" {
  statement {
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.auth_secret_arn]
  }
}

resource "aws_vpc_endpoint" "secretsmanager" {
  vpc_id              = aws_vpc.compiler.id
  service_name        = "com.amazonaws.eu-west-1.secretsmanager"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = local.private_subnet_ids
  security_group_ids  = [aws_security_group.interface_endpoints.id]
  policy              = data.aws_iam_policy_document.secretsmanager_endpoint.json
}

data "aws_iam_policy_document" "s3_endpoint" {
  statement {
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::prod-eu-west-1-starport-layer-bucket/*"]
  }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.compiler.id
  service_name      = "com.amazonaws.eu-west-1.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.compiler[*].id
  policy            = data.aws_iam_policy_document.s3_endpoint.json
}

resource "aws_vpc_security_group_egress_rule" "tasks_to_ecr_layers" {
  security_group_id = aws_security_group.compiler_task.id
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "Fetch ECR image layers from the regional S3 endpoint"
}

# Reconcile each security group as a closed allowlist so an out-of-band rule is
# visible and removed by the next reviewed Terraform apply.
resource "aws_vpc_security_group_rules_exclusive" "gateway" {
  security_group_id = aws_security_group.gateway.id
  ingress_rule_ids  = []
  egress_rule_ids = [
    aws_vpc_security_group_egress_rule.gateway_to_alb.id,
    aws_vpc_security_group_egress_rule.gateway_to_endpoints.id,
  ]
}

resource "aws_vpc_security_group_rules_exclusive" "internal_alb" {
  security_group_id = aws_security_group.internal_alb.id
  ingress_rule_ids  = [aws_vpc_security_group_ingress_rule.alb_from_gateway.id]
  egress_rule_ids   = [aws_vpc_security_group_egress_rule.alb_to_tasks.id]
}

resource "aws_vpc_security_group_rules_exclusive" "compiler_task" {
  security_group_id = aws_security_group.compiler_task.id
  ingress_rule_ids  = [aws_vpc_security_group_ingress_rule.tasks_from_alb.id]
  egress_rule_ids = [
    aws_vpc_security_group_egress_rule.tasks_to_endpoints.id,
    aws_vpc_security_group_egress_rule.tasks_to_ecr_layers.id,
  ]
}

resource "aws_vpc_security_group_rules_exclusive" "interface_endpoints" {
  security_group_id = aws_security_group.interface_endpoints.id
  ingress_rule_ids = [
    aws_vpc_security_group_ingress_rule.endpoints_from_gateway.id,
    aws_vpc_security_group_ingress_rule.endpoints_from_tasks.id,
  ]
  egress_rule_ids = []
}
