output "ecr_repository_url" {
  description = "Push the pinned linux/amd64 image here before applying the Lambda resources."
  value       = aws_ecr_repository.compiler.repository_url
}

output "compiler_function_url" {
  description = "Server-only endpoint. Store this as a Worker secret; never expose it to browsers or logs."
  value       = aws_lambda_function_url.compiler.function_url
  sensitive   = true
}

output "lambda_version" {
  description = "Immutable Lambda version currently addressed by the live alias."
  value       = aws_lambda_function.compiler.version
}
