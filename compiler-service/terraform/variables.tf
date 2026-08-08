variable "service_name" {
  description = "Stable prefix for compiler resources. Kept short enough for ALB names."
  type        = string
  default     = "firelight-compiler"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,23}$", var.service_name))
    error_message = "service_name must be 3-24 lowercase letters, numbers, or hyphens."
  }
}

variable "image_digest" {
  description = "Immutable sha256 digest of the linux/amd64 image already pushed to the managed ECR repository."
  type        = string

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.image_digest))
    error_message = "image_digest must be an immutable lowercase sha256 digest."
  }
}

variable "auth_secret_arn" {
  description = "ARN of an existing eu-west-1 Secrets Manager secret whose SecretString is the raw gateway service token."
  type        = string

  validation {
    condition = can(regex(
      "^arn:aws:secretsmanager:eu-west-1:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$",
      var.auth_secret_arn,
    ))
    error_message = "auth_secret_arn must identify an eu-west-1 Secrets Manager secret."
  }
}

variable "auth_secret_kms_key_arn" {
  description = "Optional customer-managed KMS key ARN used by the auth secret. Leave null for the aws/secretsmanager key."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.auth_secret_kms_key_arn == null || can(regex(
      "^arn:aws:kms:eu-west-1:[0-9]{12}:key/[0-9a-f-]{36}$",
      var.auth_secret_kms_key_arn,
    ))
    error_message = "auth_secret_kms_key_arn must be an eu-west-1 KMS key ARN or null."
  }
}

variable "vpc_cidr" {
  description = "Isolated compiler VPC CIDR. The VPC has no internet gateway or NAT route."
  type        = string
  default     = "10.42.0.0/20"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr)) && can(cidrsubnet(var.vpc_cidr, 4, 1))
    error_message = "vpc_cidr must be a valid IPv4 CIDR with room for two derived subnets."
  }
}

variable "gateway_reserved_concurrency" {
  description = "Maximum concurrent authenticated gateway invocations, bounding cost and ALB pressure."
  type        = number
  default     = 5

  validation {
    condition     = var.gateway_reserved_concurrency >= 1 && var.gateway_reserved_concurrency <= 20
    error_message = "gateway_reserved_concurrency must be between 1 and 20."
  }
}

variable "compiler_desired_count" {
  description = "Number of isolated single-compile Fargate tasks across two availability zones."
  type        = number
  default     = 2

  validation {
    condition     = var.compiler_desired_count >= 2 && var.compiler_desired_count <= 10
    error_message = "compiler_desired_count must be between 2 and 10."
  }
}

variable "enable_deletion_protection" {
  description = "Protect the internal ALB from accidental deletion in long-lived environments."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "Retention for Lambda gateway and ECS compiler logs."
  type        = number
  default     = 14

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90], var.log_retention_days)
    error_message = "log_retention_days must be an allowed CloudWatch Logs retention value up to 90 days."
  }
}
