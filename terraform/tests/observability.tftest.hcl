# Log groups, the alarms of part 6 §6.8 and the dashboard (WP-T5). Offline: the AWS provider is mocked.
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
  override_data {
    target = data.aws_ec2_instance_type_offerings.home
    values = { locations = ["us-east-1b", "us-east-1a", "us-east-1a", "us-east-1c"] }
  }
  override_data {
    target = data.aws_ssm_parameter.ami
    values = { insecure_value = "ami-0123456789abcdef0", value = "ami-0123456789abcdef0" }
  }
  mock_resource "aws_iam_instance_profile" {
    defaults = { arn = "arn:aws:iam::111122223333:instance-profile/dozebox-main-box" }
  }
  mock_resource "aws_launch_template" {
    defaults = { id = "lt-0123456789abcdef0", arn = "arn:aws:ec2:us-east-1:111122223333:launch-template/lt-0123456789abcdef0" }
  }
  mock_resource "aws_security_group" {
    defaults = { id = "sg-0123456789abcdef0", arn = "arn:aws:ec2:us-east-1:111122223333:security-group/sg-0123456789abcdef0" }
  }
  mock_resource "aws_subnet" {
    defaults = { id = "subnet-0123456789abcdef0" }
  }
  mock_resource "aws_vpc" {
    defaults = { id = "vpc-0123456789abcdef0" }
  }
  mock_resource "aws_instance" {
    defaults = { id = "i-0123456789abcdef0" }
  }
  mock_resource "aws_ebs_volume" {
    defaults = { id = "vol-0123456789abcdef0" }
  }
}

variables {
  box_id      = "main"
  instance    = { types = ["t4g.small"] }
  data_volume = { size_gb = 20 }
  caps        = { monthly_budget_usd = 25, awake_hours_per_day = 2 }
  payloads = {
    demo = { schema = 1, name = "demo", user = "demo", protocol = "none", start = { command = ["/bin/true"] } }
  }
  agent              = { version = "none" }
  log_retention_days = 90
}

run "one_retention_for_every_log_group" {
  command = plan

  assert {
    condition     = aws_cloudwatch_log_group.box.retention_in_days == 90 && aws_cloudwatch_log_group.control.retention_in_days == 90
    error_message = "Every log group keeps log_retention_days."
  }
  assert {
    condition     = aws_cloudwatch_log_group.box.name == "/dozebox/main/box" && aws_cloudwatch_log_group.control.name == local.names.control_log_group
    error_message = "The log groups have the names the box and control policies scope."
  }
}

run "control_quiet_sums_completed_and_skipped" {
  command = apply

  assert {
    condition     = [for q in aws_cloudwatch_metric_alarm.control_quiet.metric_query : q.expression if q.return_data][0] == "reconcilecompleted + reconcileskipped"
    error_message = "control-quiet sums completed and skipped ticks."
  }
  assert {
    condition     = toset([for q in aws_cloudwatch_metric_alarm.control_quiet.metric_query : q.metric[0].metric_name if !q.return_data]) == toset(["ReconcileCompleted", "ReconcileSkipped"])
    error_message = "control-quiet reads both tick metrics."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.control_quiet.treat_missing_data == "breaching" && aws_cloudwatch_metric_alarm.control_quiet.comparison_operator == "LessThanThreshold"
    error_message = "No ticks at all is the failure the dead-man alarm exists for."
  }
  assert {
    condition     = alltrue([for q in aws_cloudwatch_metric_alarm.control_quiet.metric_query : q.metric[0].period == 600 if !q.return_data])
    error_message = "control-quiet looks at 10 minutes."
  }
}

run "the_signal_alarms_of_part_6_notify_the_topic" {
  command = apply

  assert {
    condition     = toset([for a in aws_cloudwatch_metric_alarm.signal : a.alarm_name]) == toset(["dozebox-main-wake-unresolved", "dozebox-main-alert-path-broken", "dozebox-main-version-skew", "dozebox-main-runner-bug"])
    error_message = "wake-unresolved, alert-path-broken, version-skew and runner-bug exist."
  }
  assert {
    condition     = alltrue([for a in aws_cloudwatch_metric_alarm.signal : a.namespace == "Dozebox/main" && a.treat_missing_data == "notBreaching" && a.alarm_actions == toset([aws_sns_topic.alerts.arn])])
    error_message = "Each reads Dozebox/<box>, treats no data as fine, and notifies the topic."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.signal["wake-unresolved"].period == 1800
    error_message = "wake-unresolved looks at 30 minutes."
  }
}

run "the_dashboard_shows_caps_ticks_and_alarms" {
  command = apply

  assert {
    condition     = aws_cloudwatch_dashboard.box.dashboard_name == "dozebox-main"
    error_message = "The dashboard has the name dashboard_url points at."
  }
  assert {
    condition     = contains(flatten([for w in jsondecode(aws_cloudwatch_dashboard.box.dashboard_body).widgets : try(w.properties.metrics, [])]), "AwakeSeconds")
    error_message = "The dashboard shows awake time."
  }
  assert {
    condition     = length([for w in jsondecode(aws_cloudwatch_dashboard.box.dashboard_body).widgets : w if w.type == "alarm"][0].properties.alarms) == 7
    error_message = "The alarm widget lists both kill alarms, the four signals and control-quiet."
  }
}

run "the_prefix_names_the_namespace" {
  command = plan
  variables {
    name_prefix = "acme"
  }

  assert {
    condition     = local.metric_namespace == "Acme/main"
    error_message = "Metrics live in <Prefix>/<box_id>, so two prefixes never share a series."
  }
}
