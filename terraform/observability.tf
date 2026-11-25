# Log groups, the alarms of part 6 §6.8 and the dashboard. Metrics come from the control function and the box as
# Embedded Metric Format lines in namespace <Prefix>/<box_id> (no dimensions on the series these alarms read), so
# nothing calls PutMetricData. Every log group the module creates keeps var.log_retention_days.
resource "aws_cloudwatch_log_group" "box" {
  name              = local.names.box_log_group
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "control" {
  name              = local.names.control_log_group
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

locals {
  # Alarms that read one metric's Sum over one period. control-quiet is the dead-man alarm and is separate.
  signal_alarms = {
    wake-unresolved = {
      metric      = "WakeUnresolved"
      period      = 1800
      description = "A wake was not served within 30 minutes."
    }
    alert-path-broken = {
      metric      = "AlertFailed"
      period      = 3600
      description = "An alert sink failed to deliver in the last hour."
    }
    version-skew = {
      metric      = "RecordVersionUnknown"
      period      = 300
      description = "A record with an unknown schema version was read: the box and the control function disagree."
    }
    runner-bug = {
      metric      = "Bugs"
      period      = 3600
      description = "The runner hit a state it should never reach. Check the logs."
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "signal" {
  for_each = local.signal_alarms

  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = each.value.description
  namespace           = local.metric_namespace
  metric_name         = each.value.metric
  statistic           = "Sum"
  period              = each.value.period
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  tags                = local.tags
}

# The reconcile tick reports every run, done or skipped; no report in 10 minutes means the tick is dead.
resource "aws_cloudwatch_metric_alarm" "control_quiet" {
  alarm_name          = "${local.name}-control-quiet"
  alarm_description   = "No reconcile tick completed or skipped in 10 minutes: the control function or its schedule is broken."
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  evaluation_periods  = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dynamic "metric_query" {
    for_each = ["ReconcileCompleted", "ReconcileSkipped"]
    content {
      id          = lower(metric_query.value)
      return_data = false
      metric {
        namespace   = local.metric_namespace
        metric_name = metric_query.value
        period      = 600
        stat        = "Sum"
      }
    }
  }

  metric_query {
    id          = "ticks"
    label       = "reconcile ticks"
    return_data = true
    expression  = "reconcilecompleted + reconcileskipped"
  }

  tags = local.tags
}

locals {
  dashboard_metric = { for m in ["AwakeSeconds", "OnDemandSeconds", "ReconcileCompleted", "ReconcileSkipped", "WakeAccepted", "WakeUnresolved", "AlertDelivered", "AlertFailed", "AgentStrikes", "PayloadRestarts", "Bugs"] : m => [local.metric_namespace, m] }

  dashboard_widgets = [
    { title = "Awake and On-Demand seconds per hour", metrics = ["AwakeSeconds", "OnDemandSeconds"], period = 3600 },
    { title = "Reconcile ticks", metrics = ["ReconcileCompleted", "ReconcileSkipped"], period = 300 },
    { title = "Wakes", metrics = ["WakeAccepted", "WakeUnresolved"], period = 3600 },
    { title = "Alert deliveries", metrics = ["AlertDelivered", "AlertFailed"], period = 3600 },
    { title = "Agent strikes, payload restarts, bugs", metrics = ["AgentStrikes", "PayloadRestarts", "Bugs"], period = 3600 },
  ]
}

resource "aws_cloudwatch_dashboard" "box" {
  dashboard_name = local.names.dashboard
  dashboard_body = jsonencode({
    widgets = concat(
      [for i, w in local.dashboard_widgets : {
        type   = "metric"
        x      = (i % 2) * 12
        y      = floor(i / 2) * 6
        width  = 12
        height = 6
        properties = {
          title   = w.title
          region  = local.region
          stat    = "Sum"
          period  = w.period
          view    = "timeSeries"
          metrics = [for m in w.metrics : local.dashboard_metric[m]]
        }
      }],
      [{
        type   = "alarm"
        x      = 12
        y      = floor(length(local.dashboard_widgets) / 2) * 6
        width  = 12
        height = 6
        properties = {
          title  = "Kill switch, caps and signals"
          alarms = concat([for a in aws_cloudwatch_metric_alarm.kill : a.arn], [for a in aws_cloudwatch_metric_alarm.signal : a.arn], [aws_cloudwatch_metric_alarm.control_quiet.arn])
        }
      }],
    )
  })
}
