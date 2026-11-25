# Caps, the budget and the kill switch (part 8 §8.2, part 9 §9.2.4). The first line is the control function, which
# counts awake and On-Demand time every tick against caps (passed to it as DOZEBOX_CONTROL.caps). The kill switch is
# the backstop outside it: alarms on awake and On-Demand hours start the kill runbook through EventBridge, with no
# Lambda and no box code in the path. The budget is the slow backstop (its data is hours late) and notifies the topic.
locals {
  metric_namespace = "${title(var.name_prefix)}/${var.box_id}"

  # The groups that exist in this stack, by role (names, not resources: the control function and the runbook only
  # need the names, and a name never cycles with the group's launch template).
  cap_group_names = {
    spot     = var.instance.machine_mode == "group" ? local.names.group : null
    fallback = var.fallback.enabled ? local.names.fallback_group : null
  }
  kill_group_names = compact(values(local.cap_group_names))

  caps_config = {
    awakeHoursPerDay    = var.caps.awake_hours_per_day
    onDemandHoursPerDay = var.caps.on_demand_hours_per_day
    monthlyBudgetUsd    = var.caps.monthly_budget_usd
    maxSpotPricePerHour = var.caps.max_spot_price_per_hour
    freezeOnBudget      = var.caps.freeze_on_budget
    budgetName          = local.names.budget
  }

  # An hour counts as awake when the box ran at least kill_busy_minutes of it. The kill switch fires one hour past the
  # cap, so the control function always acts first.
  kill_busy_minutes = 50
  kill_hours = {
    awake     = var.caps.awake_hours_per_day == null ? null : min(24, ceil(var.caps.awake_hours_per_day) + 1)
    on-demand = var.fallback.enabled ? min(24, ceil(var.caps.on_demand_hours_per_day) + 1) : null
  }

  # Per alarm, the minutes-awake series: the metric the control function and the box emit (EMF, part 6 §6.8) and, where
  # a group exists, the group's own in-service minutes from AWS, which count even when nothing of dozebox runs.
  kill_series = {
    awake     = { metric = "AwakeSeconds", group = local.cap_group_names.spot }
    on-demand = { metric = "OnDemandSeconds", group = local.cap_group_names.fallback }
  }
  kill_alarms = { for k, s in local.kill_series : k => merge(s, { hours = local.kill_hours[k] }) if local.kill_hours[k] != null }

  kill_document     = "${local.name}-kill"
  unfreeze_document = "${local.name}-unfreeze"

  kill_config = {
    runbook         = local.kill_document
    unfreezeRunbook = local.unfreeze_document
    roleArn         = aws_iam_role.kill.arn
    denyPolicyArn   = local.arns.deny_policy
    freezeParameter = local.names.freeze_parameter
    alarms          = [for k in keys(local.kill_alarms) : "${local.name}-kill-${k}"]
  }

  # The kill runbook's parameters (runbooks/kill.yaml). GroupNames is left out when the stack has no group.
  kill_parameters = merge(
    {
      AutomationAssumeRole = [aws_iam_role.kill.arn]
      BoxId                = [var.box_id]
      TagKey               = ["${local.tag_prefix}:box"]
      BoxRoleName          = [aws_iam_role.box.name]
      ControlRoleName      = [aws_iam_role.control.name]
      DenyPolicyArn        = [local.arns.deny_policy]
      FreezeParameter      = [local.names.freeze_parameter]
      Reason               = ["ALARM_NAME"]
    },
    length(local.kill_group_names) == 0 ? {} : { GroupNames = local.kill_group_names },
  )
}

# The per-box budget: gross cost (no credits or refunds, which would hide spend until they run out) of everything
# tagged <prefix>:box = <box_id>. The tag must be an activated cost allocation tag (dozebox bootstrap; doctor checks).
resource "aws_budgets_budget" "box" {
  name         = local.names.budget
  budget_type  = "COST"
  limit_amount = tostring(var.caps.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = [format("user:%s:box$%s", local.tag_prefix, var.box_id)]
  }

  cost_types {
    include_credit = false
    include_refund = false
  }

  dynamic "notification" {
    for_each = [
      { type = "ACTUAL", threshold = 80 },
      { type = "ACTUAL", threshold = 100 },
      { type = "FORECASTED", threshold = 100 },
    ]
    content {
      comparison_operator       = "GREATER_THAN"
      threshold                 = notification.value.threshold
      threshold_type            = "PERCENTAGE"
      notification_type         = notification.value.type
      subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
    }
  }

  tags       = local.tags
  depends_on = [aws_sns_topic_policy.alerts]
}

# Attached by the kill runbook only, detached by the unfreeze runbook only (part 8 §8.2). No role holds it at apply.
resource "aws_iam_policy" "frozen" {
  name        = local.names.deny_policy
  description = "Kill switch for ${var.box_id}: nothing starts, launches, scales or attaches while this is attached."
  policy      = jsonencode(local.frozen_policy)
  tags        = local.tags
}

locals {
  frozen_policy = {
    Version = "2012-10-17"
    Statement = [{
      Sid      = "Frozen"
      Effect   = "Deny"
      Action   = ["ec2:StartInstances", "ec2:RunInstances", "autoscaling:SetDesiredCapacity", "autoscaling:UpdateAutoScalingGroup", "ec2:AttachVolume"]
      Resource = "*"
    }]
  }
}

resource "aws_cloudwatch_metric_alarm" "kill" {
  for_each = local.kill_alarms

  alarm_name          = "${local.name}-kill-${each.key}"
  alarm_description   = "Kill switch: ${each.value.hours} of the last 24 hours were ${each.key} hours. Freezes the box; dozebox unfreeze lifts it."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 24
  datapoints_to_alarm = each.value.hours
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "secs"
    return_data = false
    metric {
      namespace   = local.metric_namespace
      metric_name = each.value.metric
      period      = 3600
      stat        = "Sum"
    }
  }

  dynamic "metric_query" {
    for_each = each.value.group == null ? [] : [each.value.group]
    content {
      id          = "group"
      return_data = false
      metric {
        namespace   = "AWS/AutoScaling"
        metric_name = "GroupInServiceInstances"
        dimensions  = { AutoScalingGroupName = metric_query.value }
        period      = 3600
        stat        = "Sum" # one datapoint a minute: the sum is instance-minutes
      }
    }
  }

  metric_query {
    id          = "mins"
    return_data = false
    expression  = each.value.group == null ? "secs / 60" : "MAX([secs / 60, group])"
  }

  metric_query {
    id          = "busy"
    label       = "${each.key} hours"
    return_data = true
    expression  = "IF(mins >= ${local.kill_busy_minutes}, 1, 0)"
  }

  tags = local.tags
}

resource "aws_ssm_document" "kill" {
  name            = local.kill_document
  document_type   = "Automation"
  document_format = "YAML"
  content         = file("${path.module}/runbooks/kill.yaml")
  tags            = local.tags
}

resource "aws_ssm_document" "unfreeze" {
  name            = local.unfreeze_document
  document_type   = "Automation"
  document_format = "YAML"
  content         = file("${path.module}/runbooks/unfreeze.yaml")
  tags            = local.tags
}

# Exact alarm names, not a prefix: a prefix would also match a box whose id extends this one's (main, main-kill-x).
resource "aws_cloudwatch_event_rule" "kill" {
  count = length(local.kill_alarms) == 0 ? 0 : 1

  name        = "${local.name}-kill"
  description = "A kill switch alarm of ${var.box_id} went to ALARM: start the kill runbook."
  event_pattern = jsonencode({
    source        = ["aws.cloudwatch"]
    "detail-type" = ["CloudWatch Alarm State Change"]
    detail = {
      alarmName = [for a in aws_cloudwatch_metric_alarm.kill : a.alarm_name]
      state     = { value = ["ALARM"] }
    }
  })
  tags = local.tags
}

resource "aws_cloudwatch_event_target" "kill" {
  count = length(aws_cloudwatch_event_rule.kill)

  rule     = aws_cloudwatch_event_rule.kill[0].name
  arn      = "arn:${local.partition}:ssm:${local.region}:${local.account_id}:automation-definition/${aws_ssm_document.kill.name}:$DEFAULT"
  role_arn = aws_iam_role.kill_events.arn

  input_transformer {
    input_paths    = { alarm = "$.detail.alarmName" }
    input_template = replace(jsonencode(local.kill_parameters), "ALARM_NAME", "<alarm>")
  }

  retry_policy {
    maximum_retry_attempts       = 5
    maximum_event_age_in_seconds = 3600
  }
}
