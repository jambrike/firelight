locals {
  expected_service_name = {
    staging    = "firelight-compiler-stg"
    production = "firelight-compiler-prd"
  }[var.environment]
  expected_deployment_role_name = {
    staging    = "FirelightCompilerStagingDeploy"
    production = "FirelightCompilerProductionDeploy"
  }[var.environment]
  ecr_bootstrap_image_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
}

# Every plan, including the targeted ECR bootstrap, must run through an exact
# short-lived assumed-role identity. Account root and IAM-user credentials can
# never satisfy this ARN binding even if they otherwise have permission.
resource "terraform_data" "operator_gate" {
  input = {
    aws_account_id       = var.aws_account_id
    deployment_role_name = var.deployment_role_name
    environment          = var.environment
    service_name         = var.service_name
  }

  lifecycle {
    precondition {
      condition     = var.aws_account_id != "000000000000" && var.aws_account_id != "123456789012"
      error_message = "aws_account_id must be the reviewed target account, not an example value."
    }

    precondition {
      condition     = var.deployment_role_name == local.expected_deployment_role_name
      error_message = "deployment_role_name must use Firelight's canonical environment-specific role."
    }

    precondition {
      condition     = var.service_name == local.expected_service_name
      error_message = "service_name must use Firelight's canonical environment-specific name."
    }

    precondition {
      condition = can(regex(
        "^arn:aws:sts::${var.aws_account_id}:assumed-role/${var.deployment_role_name}/[A-Za-z0-9+=,.@_-]{2,64}$",
        data.aws_caller_identity.current.arn,
      ))
      error_message = "Terraform must run as the exact environment deploy role; account root and IAM users are forbidden."
    }
  }
}

# This resource makes unsafe runtime inputs a hard plan failure. The ECR
# repository may still be bootstrapped explicitly while the canonical sentinel
# is present; every complete plan and every VPC/runtime target includes this gate.
resource "terraform_data" "release_gate" {
  input = {
    aws_account_id   = var.aws_account_id
    environment      = var.environment
    image_digest     = var.image_digest
    release_build_id = var.release_build_id
    service_name     = var.service_name
  }

  lifecycle {
    precondition {
      condition     = var.service_name == local.expected_service_name
      error_message = "service_name must use Firelight's canonical environment-specific name."
    }

    precondition {
      condition     = var.image_digest != local.ecr_bootstrap_image_digest
      error_message = "a complete runtime plan requires the registry-reported immutable image digest."
    }

    precondition {
      condition     = split(":", var.auth_secret_arn)[4] == var.aws_account_id
      error_message = "auth_secret_arn must belong to the reviewed target AWS account."
    }

    precondition {
      condition = (
        var.auth_secret_kms_key_arn == null ||
        split(":", var.auth_secret_kms_key_arn)[4] == var.aws_account_id
      )
      error_message = "auth_secret_kms_key_arn must belong to the reviewed target AWS account."
    }
  }

  depends_on = [terraform_data.operator_gate]
}
