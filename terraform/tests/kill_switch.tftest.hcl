# The kill switch (WP-T5): alarms one hour past each cap, the rule that starts the kill runbook, the runbooks'
# parameters, the deny policy and the kill-events role. Offline: the AWS provider is mocked.
mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "111122223333" }
  }
  override_data {
    target = data.aws_region.current
    values = { region = "us-east-1" }
  }
  override_data {
    target = data.aws_partition.current
    values = { partition = "aws" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-1:111122223333:dozebox-main-alerts" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111122223333:role/dozebox-main-mock" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::111122223333:policy/dozebox-main-mock" }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:us-east-1:111122223333:rule/dozebox-main-mock" }
  }
  mock_resource "aws_cloudwatch_metric_alarm" {
    defaults = { arn = "arn:aws:cloudwatch:us-east-1:111122223333:alarm:dozebox-main-mock" }
  }
  override_resource {
    target = aws_lambda_function.control
    values = { arn = "arn:aws:lambda:us-east-1:111122223333:function:dozebox-main-control", version = "3" }
  }
  override_resource {
    target = aws_lambda_alias.live
    values = { arn = "arn:aws:lambda:us-east-1:111122223333:function:dozebox-main-control:live" }
  }
  override_resource {
    target = aws_lambda_function_url.control
    values = { function_url = "https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws/" }
  }
  override_resource {
    target = aws_sqs_queue.control_dlq
    values = { arn = "arn:aws:sqs:us-east-1:111122223333:dozebox-main-control-dlq" }
  }
}

variables {
  box_id      = "main"
  instance    = { types = ["t4g.small"] }
  data_volume = { size_gb = 20 }
  caps        = { monthly_budget_usd = 25, awake_hours_per_day = 2, on_demand_hours_per_day = 1 }
  payloads = {
    demo = { schema = 1, name = "demo", user = "demo", protocol = "none", start = { command = ["/bin/true"] } }
  }
  agent = { version = "none" }
}

run "the_alarms_fire_one_hour_past_each_cap" {
  command = apply

  assert {
    condition     = toset([for a in aws_cloudwatch_metric_alarm.kill : a.alarm_name]) == toset(["dozebox-main-kill-awake", "dozebox-main-kill-on-demand"])
    error_message = "One kill alarm per cap, all named <name>-kill-* (the phase 1 exit lists them by that prefix)."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.kill["awake"].datapoints_to_alarm == 3 && aws_cloudwatch_metric_alarm.kill["on-demand"].datapoints_to_alarm == 2
    error_message = "Kill at cap + 1 awake hours of the last 24 (2 h cap -> 3, 1 h On-Demand cap -> 2)."
  }
  assert {
    condition     = alltrue([for a in aws_cloudwatch_metric_alarm.kill : a.evaluation_periods == 24 && a.threshold == 1 && a.treat_missing_data == "notBreaching"])
    error_message = "Each alarm counts busy hours over the last 24; no data is not an awake hour."
  }
  assert {
    condition     = alltrue([for a in aws_cloudwatch_metric_alarm.kill : a.alarm_actions == toset([aws_sns_topic.alerts.arn])])
    error_message = "A kill alarm also tells the operator."
  }
}

run "the_alarms_read_the_emf_metric_and_the_groups_own_minutes" {
  command = plan

  assert {
    condition = [for q in aws_cloudwatch_metric_alarm.kill["awake"].metric_query :
    [q.metric[0].namespace, q.metric[0].metric_name, tostring(q.metric[0].period), q.metric[0].stat] if q.id == "secs"][0] == ["Dozebox/main", "AwakeSeconds", "3600", "Sum"]
    error_message = "The awake alarm reads AwakeSeconds per hour from Dozebox/<box>."
  }
  assert {
    condition     = length([for q in aws_cloudwatch_metric_alarm.kill["awake"].metric_query : q if q.id == "group"]) == 0
    error_message = "A persistent box has no Spot group series in the awake alarm."
  }
  assert {
    condition     = [for q in aws_cloudwatch_metric_alarm.kill["on-demand"].metric_query : q.metric[0].dimensions if q.id == "group"][0] == tomap({ AutoScalingGroupName = "dozebox-main-od" })
    error_message = "The On-Demand alarm also counts the fallback group's in-service minutes, which need nothing of dozebox to run."
  }
  assert {
    condition     = [for q in aws_cloudwatch_metric_alarm.kill["on-demand"].metric_query : q.expression if q.id == "busy"][0] == "IF(mins >= 50, 1, 0)"
    error_message = "An hour is busy at 50 or more awake minutes."
  }
}

run "group_mode_counts_the_spot_group" {
  command = plan
  variables {
    instance = { types = ["t4g.small"], machine_mode = "group" }
  }

  assert {
    condition     = [for q in aws_cloudwatch_metric_alarm.kill["awake"].metric_query : q.metric[0].dimensions if q.id == "group"][0] == tomap({ AutoScalingGroupName = "dozebox-main" })
    error_message = "In group mode the awake alarm counts the Spot group's minutes."
  }
  assert {
    condition     = contains(jsondecode(aws_cloudwatch_event_target.kill[0].input_transformer[0].input_template).GroupNames, "dozebox-main")
    error_message = "The runbook zeroes the Spot group too."
  }
}

run "no_caps_no_alarms_no_rule" {
  command = plan
  variables {
    caps     = { monthly_budget_usd = 25 }
    fallback = { enabled = false }
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.kill) == 0 && length(aws_cloudwatch_event_rule.kill) == 0 && length(aws_cloudwatch_event_target.kill) == 0
    error_message = "Without an awake cap or a fallback group there is nothing to kill on."
  }
}

run "the_rule_catches_exactly_these_alarms_and_starts_the_runbook" {
  command = apply

  assert {
    condition = jsondecode(aws_cloudwatch_event_rule.kill[0].event_pattern) == {
      source        = ["aws.cloudwatch"]
      "detail-type" = ["CloudWatch Alarm State Change"]
      detail        = { alarmName = ["dozebox-main-kill-awake", "dozebox-main-kill-on-demand"], state = { value = ["ALARM"] } }
    }
    error_message = "The rule matches the exact alarm names going to ALARM (a prefix would catch another box)."
  }
  assert {
    condition     = aws_cloudwatch_event_target.kill[0].arn == "arn:aws:ssm:us-east-1:111122223333:automation-definition/dozebox-main-kill:$DEFAULT"
    error_message = "The target is the kill runbook."
  }
  assert {
    condition     = aws_cloudwatch_event_target.kill[0].role_arn == aws_iam_role.kill_events.arn
    error_message = "EventBridge starts it with the kill-events role."
  }
  assert {
    condition     = [for s in local.kill_events_policy.Statement : s.Resource if s.Sid == "PassOnlyTheKillRole"][0] == [aws_iam_role.kill.arn]
    error_message = "The kill-events role passes only the kill role."
  }
  assert {
    condition     = aws_cloudwatch_event_target.kill[0].input_transformer[0].input_paths == tomap({ alarm = "$.detail.alarmName" })
    error_message = "The alarm name becomes the runbook's Reason."
  }
  assert {
    condition     = strcontains(aws_cloudwatch_event_target.kill[0].input_transformer[0].input_template, "\"Reason\":[\"<alarm>\"]")
    error_message = "The Reason placeholder is raw <alarm> (jsonencode would escape the angle brackets)."
  }
}

run "the_runbook_parameters_match_the_document" {
  command = plan

  assert {
    condition     = length(setsubtract(keys(local.kill_parameters), keys(yamldecode(file("runbooks/kill.yaml")).parameters))) == 0
    error_message = "Every parameter the rule passes is declared in runbooks/kill.yaml."
  }
  assert {
    condition = length(setsubtract(
      [for k, p in yamldecode(file("runbooks/kill.yaml")).parameters : k if !can(p.default)],
      keys(local.kill_parameters),
    )) == 0
    error_message = "The rule passes every required parameter of runbooks/kill.yaml."
  }
  assert {
    condition = jsondecode(replace(aws_cloudwatch_event_target.kill[0].input_transformer[0].input_template, "<alarm>", "x")) == {
      AutomationAssumeRole = [aws_iam_role.kill.arn], BoxId = ["main"], TagKey = ["dozebox:box"]
      BoxRoleName          = ["dozebox-main-box"], ControlRoleName = ["dozebox-main-control"]
      DenyPolicyArn        = ["arn:aws:iam::111122223333:policy/dozebox-main-frozen"], FreezeParameter = ["/dozebox/main/freeze"]
      GroupNames           = ["dozebox-main-od"], Reason = ["x"]
    }
    error_message = "The runbook runs as the kill role, on this box's roles, groups and freeze record."
  }
  assert {
    condition     = aws_ssm_document.kill.document_type == "Automation" && aws_ssm_document.kill.content == file("runbooks/kill.yaml") && aws_ssm_document.kill.name == "dozebox-main-kill"
    error_message = "The kill document is runbooks/kill.yaml."
  }
  assert {
    condition     = aws_ssm_document.unfreeze.content == file("runbooks/unfreeze.yaml") && aws_ssm_document.unfreeze.name == "dozebox-main-unfreeze"
    error_message = "The unfreeze document is runbooks/unfreeze.yaml."
  }
}

run "the_deny_policy_freezes_everything_that_costs" {
  command = plan

  assert {
    condition = jsondecode(aws_iam_policy.frozen.policy).Statement == [{
      Sid    = "Frozen", Effect = "Deny", Resource = "*"
      Action = ["ec2:StartInstances", "ec2:RunInstances", "autoscaling:SetDesiredCapacity", "autoscaling:UpdateAutoScalingGroup", "ec2:AttachVolume"]
    }]
    error_message = "The deny policy is part 8 §8.2's Frozen statement."
  }
  assert {
    condition     = aws_iam_policy.frozen.name == "dozebox-main-frozen"
    error_message = "Its name is what the kill and unfreeze policies scope (local.arns.deny_policy)."
  }
  assert {
    condition     = alltrue([for role, list in local.role_policies : !contains([for p in list : p.name], aws_iam_policy.frozen.name)])
    error_message = "No role holds the deny policy at apply time."
  }
}

run "the_kill_events_role_only_starts_the_kill_runbook" {
  command = plan
  variables {
    box_id                   = "a2345678901234567890"
    iam_permissions_boundary = "arn:aws:iam::111122223333:policy/test-boundary"
  }

  assert {
    condition     = sort(flatten([for s in local.kill_events_policy.Statement : s.Action])) == tolist(["iam:PassRole", "ssm:StartAutomationExecution"])
    error_message = "The kill-events role starts automation and passes a role, nothing else."
  }
  assert {
    condition     = length(jsonencode(local.kill_events_policy)) <= 5500
    error_message = "The kill-events policy fits the 5,500 character budget with a 20-character box id."
  }
  assert {
    condition     = aws_iam_role.kill_events.permissions_boundary == "arn:aws:iam::111122223333:policy/test-boundary"
    error_message = "The role carries the permissions boundary."
  }
  assert {
    condition     = jsondecode(aws_iam_role.kill_events.assume_role_policy).Statement[0].Principal == { Service = "events.amazonaws.com" }
    error_message = "Only EventBridge assumes it."
  }
}
