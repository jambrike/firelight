locals {
  compiler_alarm_actions = [aws_sns_topic.compiler_alerts.arn]
  gateway_metric_dimensions = {
    FunctionName = aws_lambda_function.gateway.function_name
    Resource     = "${aws_lambda_function.gateway.function_name}:${aws_lambda_alias.live.name}"
  }
  ecs_service_metric_dimensions = {
    ClusterName = aws_ecs_cluster.compiler.name
    ServiceName = aws_ecs_service.compiler.name
  }
  alb_target_metric_dimensions = {
    LoadBalancer = aws_lb.compiler.arn_suffix
    TargetGroup  = aws_lb_target_group.compiler.arn_suffix
  }
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_iam_policy_document" "compiler_alerts_kms" {
  statement {
    sid    = "EnableAccountRootAdministration"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "AllowCloudWatchAlarmEncryption"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values = [
        "arn:${data.aws_partition.current.partition}:cloudwatch:eu-west-1:${data.aws_caller_identity.current.account_id}:alarm:${var.service_name}-*",
      ]
    }
  }
}

resource "aws_kms_key" "compiler_alerts" {
  description             = "Encrypts Firelight compiler CloudWatch alarm notifications"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.compiler_alerts_kms.json
}

resource "aws_kms_alias" "compiler_alerts" {
  name          = "alias/${var.service_name}-alerts"
  target_key_id = aws_kms_key.compiler_alerts.key_id
}

# Recipient addresses and escalation-system credentials deliberately stay out of
# Terraform inputs and state. Operators subscribe the named primary and backup
# through the approved alerting system, then confirm delivery as a hosted gate.
resource "aws_sns_topic" "compiler_alerts" {
  name              = "${var.service_name}-alerts"
  kms_master_key_id = aws_kms_key.compiler_alerts.arn
}

data "aws_iam_policy_document" "compiler_alerts_topic" {
  statement {
    sid    = "AllowAccountAdministration"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    actions = [
      "SNS:DeleteTopic",
      "SNS:GetTopicAttributes",
      "SNS:ListSubscriptionsByTopic",
      "SNS:Publish",
      "SNS:SetTopicAttributes",
      "SNS:Subscribe",
      "SNS:Unsubscribe",
    ]
    resources = [aws_sns_topic.compiler_alerts.arn]
  }

  statement {
    sid    = "AllowFirelightCloudWatchAlarms"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.compiler_alerts.arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values = [
        "arn:${data.aws_partition.current.partition}:cloudwatch:eu-west-1:${data.aws_caller_identity.current.account_id}:alarm:${var.service_name}-*",
      ]
    }
  }
}

resource "aws_sns_topic_policy" "compiler_alerts" {
  arn    = aws_sns_topic.compiler_alerts.arn
  policy = data.aws_iam_policy_document.compiler_alerts_topic.json
}

resource "aws_cloudwatch_metric_alarm" "gateway_url_5xx" {
  alarm_name                = "${var.service_name}-gateway-url-5xx"
  alarm_description         = "The authenticated compiler Function URL returned a server error. Follow docs/monitoring.md."
  comparison_operator       = "GreaterThanOrEqualToThreshold"
  evaluation_periods        = 1
  datapoints_to_alarm       = 1
  threshold                 = 1
  metric_name               = "Url5xxCount"
  namespace                 = "AWS/Lambda"
  period                    = 300
  statistic                 = "Sum"
  unit                      = "Count"
  dimensions                = local.gateway_metric_dimensions
  treat_missing_data        = "notBreaching"
  alarm_actions             = local.compiler_alarm_actions
  ok_actions                = local.compiler_alarm_actions
  insufficient_data_actions = []
}

resource "aws_cloudwatch_metric_alarm" "gateway_errors" {
  alarm_name                = "${var.service_name}-gateway-errors"
  alarm_description         = "The compiler gateway Lambda failed an invocation. Follow docs/monitoring.md."
  comparison_operator       = "GreaterThanOrEqualToThreshold"
  evaluation_periods        = 1
  datapoints_to_alarm       = 1
  threshold                 = 1
  metric_name               = "Errors"
  namespace                 = "AWS/Lambda"
  period                    = 300
  statistic                 = "Sum"
  unit                      = "Count"
  dimensions                = local.gateway_metric_dimensions
  treat_missing_data        = "notBreaching"
  alarm_actions             = local.compiler_alarm_actions
  ok_actions                = local.compiler_alarm_actions
  insufficient_data_actions = []
}

resource "aws_cloudwatch_metric_alarm" "gateway_throttles" {
  alarm_name                = "${var.service_name}-gateway-throttles"
  alarm_description         = "The compiler gateway exhausted its bounded concurrency. Follow docs/monitoring.md."
  comparison_operator       = "GreaterThanOrEqualToThreshold"
  evaluation_periods        = 1
  datapoints_to_alarm       = 1
  threshold                 = 1
  metric_name               = "Throttles"
  namespace                 = "AWS/Lambda"
  period                    = 300
  statistic                 = "Sum"
  unit                      = "Count"
  dimensions                = local.gateway_metric_dimensions
  treat_missing_data        = "notBreaching"
  alarm_actions             = local.compiler_alarm_actions
  ok_actions                = local.compiler_alarm_actions
  insufficient_data_actions = []
}

resource "aws_cloudwatch_metric_alarm" "gateway_duration" {
  alarm_name                = "${var.service_name}-gateway-duration"
  alarm_description         = "A gateway invocation approached the fixed 45-second deadline. Follow docs/monitoring.md."
  comparison_operator       = "GreaterThanOrEqualToThreshold"
  evaluation_periods        = 1
  datapoints_to_alarm       = 1
  threshold                 = 40000
  metric_name               = "Duration"
  namespace                 = "AWS/Lambda"
  period                    = 300
  statistic                 = "Maximum"
  unit                      = "Milliseconds"
  dimensions                = local.gateway_metric_dimensions
  treat_missing_data        = "notBreaching"
  alarm_actions             = local.compiler_alarm_actions
  ok_actions                = local.compiler_alarm_actions
  insufficient_data_actions = []
}

resource "aws_cloudwatch_metric_alarm" "ecs_running_tasks" {
  alarm_name          = "${var.service_name}-ecs-running-tasks"
  alarm_description   = "The compiler service has fewer running tasks than its Terraform desired count. Follow docs/monitoring.md."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = var.compiler_desired_count
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 60
  statistic           = "Minimum"
  unit                = "Count"
  dimensions          = local.ecs_service_metric_dimensions
  # Container Insights stops publishing this service metric when no task is
  # running, which is an outage rather than healthy missing traffic.
  treat_missing_data        = "breaching"
  alarm_actions             = local.compiler_alarm_actions
  ok_actions                = local.compiler_alarm_actions
  insufficient_data_actions = []
}

resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  alarm_name                = "${var.service_name}-ecs-cpu"
  alarm_description         = "Compiler task CPU stayed saturated for three minutes. Follow docs/monitoring.md."
  comparison_operator       = "GreaterThanOrEqualToThreshold"
  evaluation_periods        = 3
  datapoints_to_alarm       = 3
  threshold                 = 90
  metric_name               = "CPUUtilization"
  namespace                 = "AWS/ECS"
  period                    = 60
  statistic                 = "Average"
  unit                      = "Percent"
  dimensions                = local.ecs_service_metric_dimensions
  treat_missing_data        = "notBreaching"
  alarm_actions             = local.compiler_alarm_actions
  ok_actions                = local.compiler_alarm_actions
  insufficient_data_actions = []
}

resource "aws_cloudwatch_metric_alarm" "ecs_memory" {
  alarm_name                = "${var.service_name}-ecs-memory"
  alarm_description         = "Compiler task memory stayed above 85 percent for three minutes. Follow docs/monitoring.md."
  comparison_operator       = "GreaterThanOrEqualToThreshold"
  evaluation_periods        = 3
  datapoints_to_alarm       = 3
  threshold                 = 85
  metric_name               = "MemoryUtilization"
  namespace                 = "AWS/ECS"
  period                    = 60
  statistic                 = "Average"
  unit                      = "Percent"
  dimensions                = local.ecs_service_metric_dimensions
  treat_missing_data        = "notBreaching"
  alarm_actions             = local.compiler_alarm_actions
  ok_actions                = local.compiler_alarm_actions
  insufficient_data_actions = []
}

resource "aws_cloudwatch_metric_alarm" "alb_unhealthy_targets" {
  alarm_name          = "${var.service_name}-alb-unhealthy-targets"
  alarm_description   = "The internal compiler ALB reported an unhealthy target or stopped publishing target health. Follow docs/monitoring.md."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 1
  metric_name         = "UnHealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Maximum"
  unit                = "Count"
  dimensions          = local.alb_target_metric_dimensions
  # ALB stops publishing this metric when no target is registered; that is an
  # outage for this fixed-capacity service, not an idle healthy state.
  treat_missing_data        = "breaching"
  alarm_actions             = local.compiler_alarm_actions
  ok_actions                = local.compiler_alarm_actions
  insufficient_data_actions = []
}

resource "aws_cloudwatch_metric_alarm" "alb_target_5xx" {
  alarm_name                = "${var.service_name}-alb-target-5xx"
  alarm_description         = "The isolated compiler returned a server error through the ALB. Follow docs/monitoring.md."
  comparison_operator       = "GreaterThanOrEqualToThreshold"
  evaluation_periods        = 1
  datapoints_to_alarm       = 1
  threshold                 = 1
  metric_name               = "HTTPCode_Target_5XX_Count"
  namespace                 = "AWS/ApplicationELB"
  period                    = 300
  statistic                 = "Sum"
  unit                      = "Count"
  dimensions                = local.alb_target_metric_dimensions
  treat_missing_data        = "notBreaching"
  alarm_actions             = local.compiler_alarm_actions
  ok_actions                = local.compiler_alarm_actions
  insufficient_data_actions = []
}

resource "aws_cloudwatch_metric_alarm" "alb_connection_errors" {
  alarm_name                = "${var.service_name}-alb-connection-errors"
  alarm_description         = "The internal ALB could not connect to a compiler target. Follow docs/monitoring.md."
  comparison_operator       = "GreaterThanOrEqualToThreshold"
  evaluation_periods        = 1
  datapoints_to_alarm       = 1
  threshold                 = 1
  metric_name               = "TargetConnectionErrorCount"
  namespace                 = "AWS/ApplicationELB"
  period                    = 300
  statistic                 = "Sum"
  unit                      = "Count"
  dimensions                = local.alb_target_metric_dimensions
  treat_missing_data        = "notBreaching"
  alarm_actions             = local.compiler_alarm_actions
  ok_actions                = local.compiler_alarm_actions
  insufficient_data_actions = []
}

resource "aws_cloudwatch_metric_alarm" "alb_latency" {
  alarm_name                = "${var.service_name}-alb-latency"
  alarm_description         = "An isolated compile took at least 35 seconds, approaching the bounded deadline. Follow docs/monitoring.md."
  comparison_operator       = "GreaterThanOrEqualToThreshold"
  evaluation_periods        = 1
  datapoints_to_alarm       = 1
  threshold                 = 35
  metric_name               = "TargetResponseTime"
  namespace                 = "AWS/ApplicationELB"
  period                    = 300
  statistic                 = "Maximum"
  unit                      = "Seconds"
  dimensions                = local.alb_target_metric_dimensions
  treat_missing_data        = "notBreaching"
  alarm_actions             = local.compiler_alarm_actions
  ok_actions                = local.compiler_alarm_actions
  insufficient_data_actions = []
}

resource "aws_cloudwatch_dashboard" "compiler" {
  dashboard_name = "${var.service_name}-operations"
  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Compiler gateway"
          region = "eu-west-1"
          view   = "timeSeries"
          period = 300
          stat   = "Sum"
          metrics = [
            ["AWS/Lambda", "UrlRequestCount", "FunctionName", aws_lambda_function.gateway.function_name, "Resource", "${aws_lambda_function.gateway.function_name}:${aws_lambda_alias.live.name}"],
            [".", "Url5xxCount", ".", ".", ".", "."],
            [".", "Errors", ".", ".", ".", "."],
            [".", "Throttles", ".", ".", ".", "."],
            [".", "Duration", ".", ".", ".", ".", { stat = "Maximum", yAxis = "right" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Compiler ECS service"
          region = "eu-west-1"
          view   = "timeSeries"
          period = 60
          metrics = [
            ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", aws_ecs_cluster.compiler.name, "ServiceName", aws_ecs_service.compiler.name, { stat = "Minimum" }],
            [".", "DesiredTaskCount", ".", ".", ".", ".", { stat = "Maximum" }],
            ["AWS/ECS", "CPUUtilization", "ClusterName", aws_ecs_cluster.compiler.name, "ServiceName", aws_ecs_service.compiler.name, { stat = "Average", yAxis = "right" }],
            [".", "MemoryUtilization", ".", ".", ".", ".", { stat = "Average", yAxis = "right" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 24
        height = 6
        properties = {
          title  = "Internal compiler ALB"
          region = "eu-west-1"
          view   = "timeSeries"
          period = 300
          stat   = "Sum"
          metrics = [
            ["AWS/ApplicationELB", "UnHealthyHostCount", "LoadBalancer", aws_lb.compiler.arn_suffix, "TargetGroup", aws_lb_target_group.compiler.arn_suffix, { stat = "Maximum" }],
            [".", "HTTPCode_Target_5XX_Count", ".", ".", ".", "."],
            [".", "TargetConnectionErrorCount", ".", ".", ".", "."],
            [".", "TargetResponseTime", ".", ".", ".", ".", { stat = "Maximum", yAxis = "right" }],
          ]
        }
      },
    ]
  })
}
