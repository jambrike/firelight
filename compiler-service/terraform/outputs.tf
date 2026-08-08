output "ecr_repository_url" {
  description = "Push the pinned linux/amd64 gateway/compiler image here before applying runtime resources."
  value       = aws_ecr_repository.compiler.repository_url
}

output "compiler_gateway_function_url" {
  description = "Server-only public gateway. Store as a Worker secret; never expose it to browsers or logs."
  value       = aws_lambda_function_url.gateway.function_url
  sensitive   = true
}

output "gateway_lambda_version" {
  description = "Immutable gateway version currently addressed by the live alias."
  value       = aws_lambda_function.gateway.version
}

output "compiler_cluster_name" {
  description = "ECS cluster containing the isolated compiler service."
  value       = aws_ecs_cluster.compiler.name
}

output "compiler_service_name" {
  description = "ECS service behind the internal ALB."
  value       = aws_ecs_service.compiler.name
}

output "internal_compiler_alb_dns_name" {
  description = "Private diagnostic endpoint; resolvable only inside the isolated VPC."
  value       = aws_lb.compiler.dns_name
  sensitive   = true
}

output "compiler_vpc_id" {
  description = "No-NAT VPC containing the gateway ENIs, internal ALB, endpoints, and compiler tasks."
  value       = aws_vpc.compiler.id
}

output "compiler_alerts_topic_arn" {
  description = "Encrypted SNS topic for compiler ALARM and OK notifications; subscribe approved responders outside Terraform state."
  value       = aws_sns_topic.compiler_alerts.arn
}

output "compiler_dashboard_name" {
  description = "CloudWatch dashboard containing the compiler gateway, ECS service, and internal ALB signals."
  value       = aws_cloudwatch_dashboard.compiler.dashboard_name
}
