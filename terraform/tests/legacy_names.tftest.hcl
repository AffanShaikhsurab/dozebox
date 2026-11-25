mock_provider "aws" {
  # Real-shaped values: the mock's random strings would make ARNs short (and the provider rejects some of them).
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "111122223333" }
  }
  override_data {
    target = data.aws_region.current
    values = { region = "ap-southeast-2" }
  }
  override_data {
    target = data.aws_partition.current
    values = { partition = "aws" }
  }
  override_data {
    target = data.aws_ec2_instance_type_offerings.home
    values = { locations = ["ap-southeast-2b", "ap-southeast-2a", "ap-southeast-2a", "ap-southeast-2c"] }
  }
  override_data {
    target = data.aws_ssm_parameter.ami
    values = { insecure_value = "ami-0123456789abcdef0", value = "ami-0123456789abcdef0" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111122223333:role/dozebox-a2345678901234567890-scheduler" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::111122223333:policy/dozebox-a2345678901234567890-control-volumes" }
  }
  mock_resource "aws_iam_instance_profile" {
    defaults = { arn = "arn:aws:iam::111122223333:instance-profile/dozebox-a2345678901234567890-box" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:ap-southeast-2:111122223333:dozebox-a2345678901234567890-alerts" }
  }
  mock_resource "aws_launch_template" {
    defaults = { id = "lt-0123456789abcdef0", arn = "arn:aws:ec2:ap-southeast-2:111122223333:launch-template/lt-0123456789abcdef0" }
  }
  mock_resource "aws_security_group" {
    defaults = { id = "sg-0123456789abcdef0", arn = "arn:aws:ec2:ap-southeast-2:111122223333:security-group/sg-0123456789abcdef0" }
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
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:ap-southeast-2:111122223333:rule/dozebox-main-mock" }
  }
  mock_resource "aws_cloudwatch_metric_alarm" {
    defaults = { arn = "arn:aws:cloudwatch:ap-southeast-2:111122223333:alarm:dozebox-main-mock" }
  }
  override_resource {
    target = aws_lambda_function.control
    values = { arn = "arn:aws:lambda:ap-southeast-2:111122223333:function:dozebox-main-control", version = "3" }
  }
  override_resource {
    target = aws_lambda_alias.live
    values = { arn = "arn:aws:lambda:ap-southeast-2:111122223333:function:dozebox-main-control:live" }
  }
  override_resource {
    target = aws_lambda_function_url.control
    values = { function_url = "https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.ap-southeast-2.on.aws/" }
  }
  override_resource {
    target = aws_sqs_queue.control_dlq
    values = { arn = "arn:aws:sqs:ap-southeast-2:111122223333:dozebox-main-control-dlq" }
  }
}

variables {
  box_id      = "main"
  instance    = { types = ["t4g.small", "t4g.medium"] }
  data_volume = { size_gb = 20 }
  caps        = { monthly_budget_usd = 25 }
  payloads = {
    demo = { schema = 1, name = "demo", user = "demo", protocol = "none", start = { command = ["/bin/true"] } }
  }
  agent = { version = "none" }
}

# WP-T6: an adopted stack keeps today's names. tests/fixtures/legacy-names.json lists the names of the old root
# (legacy/terraform/runner) that the module reproduces for name_prefix = "t3box", box_id = "main".
run "legacy_names_match_the_fixture" {
  command = plan
  variables {
    name_prefix = "t3box"
    ssm_prefix  = "/t3box/main/"
    tag_prefix  = "t3box"
  }

  assert {
    condition = jsondecode(file("tests/fixtures/legacy-names.json")) == {
      box_log_group          = aws_cloudwatch_log_group.box.name
      control_log_group      = aws_cloudwatch_log_group.control.name
      spot_group             = local.names.group
      fallback_group         = aws_autoscaling_group.fallback[0].name
      control_function       = aws_lambda_function.control.function_name
      control_role           = aws_iam_role.control.name
      scheduler_role         = aws_iam_role.scheduler.name
      kill_role              = aws_iam_role.kill.name
      kill_events_role       = aws_iam_role.kill_events.name
      kill_document          = aws_ssm_document.kill.name
      reconcile_schedule     = aws_scheduler_schedule.reconcile.name
      alert_topic            = aws_sns_topic.alerts.name
      budget                 = aws_budgets_budget.box.name
      data_volume            = aws_ebs_volume.data[0].tags["Name"]
      data_volume_active_tag = one([for k in keys(aws_ebs_volume.data[0].tags) : k if endswith(k, ":active")])
      config_parameter       = aws_ssm_parameter.config.name
      ssm_prefix             = output.ssm_prefix
      tag_prefix             = output.tag_prefix
    }
    error_message = "With the legacy prefixes the module's names equal tests/fixtures/legacy-names.json."
  }
}

run "legacy_prefixes_equal_the_defaults_of_name_prefix_t3box" {
  command = plan
  variables {
    name_prefix = "t3box"
  }

  assert {
    condition     = local.ssm_prefix == "/t3box/main/" && local.tag_prefix == "t3box" && local.names.box_log_group == "/t3box/main/box"
    error_message = "A null ssm_prefix and tag_prefix follow name_prefix."
  }
  assert {
    condition     = local.ssm_shared_arn == "arn:aws:ssm:ap-southeast-2:111122223333:parameter/t3box/shared"
    error_message = "Shared secrets stay under /<name_prefix>/shared."
  }
}

run "overrides_move_every_ssm_path_and_tag_key" {
  command = plan
  variables {
    ssm_prefix = "/legacy/main/"
    tag_prefix = "old"
  }

  assert {
    condition = (
      aws_ssm_parameter.config.name == "/legacy/main/config" && aws_ssm_parameter.payload["demo"].name == "/legacy/main/payloads/demo" &&
      local.names.freeze_parameter == "/legacy/main/freeze" && local.names.box_log_group == "/legacy/main/box" &&
      output.ssm_prefix == "/legacy/main/" && output.wake_token_parameter == "/legacy/main/wake-token"
    )
    error_message = "ssm_prefix replaces /<name_prefix>/<box_id>/ in every parameter and in the box log group."
  }
  assert {
    condition = (
      local.ssm_box_arn == "arn:aws:ssm:ap-southeast-2:111122223333:parameter/legacy/main" &&
      local.ssm_shared_arn == "arn:aws:ssm:ap-southeast-2:111122223333:parameter/legacy/shared"
    )
    error_message = "The IAM parameter ARNs follow ssm_prefix, and shared secrets sit beside the box prefix."
  }
  assert {
    condition = (
      aws_ebs_volume.data[0].tags["old:active"] == "true" && aws_ebs_volume.data[0].tags["old:box"] == "main" &&
      !contains(keys(aws_ebs_volume.data[0].tags), "dozebox:box") && output.tag_prefix == "old"
    )
    error_message = "tag_prefix replaces name_prefix in the <prefix>:box and :active tag keys."
  }
  assert {
    condition     = aws_budgets_budget.box.name == "dozebox-main-monthly" && aws_sns_topic.alerts.name == "dozebox-main-alerts"
    error_message = "Resource names keep following name_prefix."
  }
}

run "a_single_segment_ssm_prefix_puts_shared_secrets_at_the_root" {
  command = plan
  variables {
    ssm_prefix = "/solo/"
  }

  assert {
    condition     = local.ssm_shared_arn == "arn:aws:ssm:ap-southeast-2:111122223333:parameter/shared" && local.ssm_box_arn == "arn:aws:ssm:ap-southeast-2:111122223333:parameter/solo"
    error_message = "A one-segment ssm_prefix has /shared as its sibling."
  }
}

run "defaults_keep_the_dozebox_names" {
  command = plan

  assert {
    condition     = output.ssm_prefix == "/dozebox/main/" && output.tag_prefix == "dozebox" && local.ssm_shared_arn == "arn:aws:ssm:ap-southeast-2:111122223333:parameter/dozebox/shared"
    error_message = "Without overrides the names are the module's own."
  }
}

run "rejects_ssm_prefix_without_leading_slash" {
  command = plan
  variables {
    ssm_prefix = "legacy/main/"
  }
  expect_failures = [var.ssm_prefix]
}

run "rejects_ssm_prefix_without_trailing_slash" {
  command = plan
  variables {
    ssm_prefix = "/legacy/main"
  }
  expect_failures = [var.ssm_prefix]
}

run "rejects_ssm_prefix_with_a_space" {
  command = plan
  variables {
    ssm_prefix = "/legacy /main/"
  }
  expect_failures = [var.ssm_prefix]
}

run "rejects_tag_prefix_uppercase" {
  command = plan
  variables {
    tag_prefix = "T3box"
  }
  expect_failures = [var.tag_prefix]
}

run "rejects_tag_prefix_digit_first" {
  command = plan
  variables {
    tag_prefix = "1box"
  }
  expect_failures = [var.tag_prefix]
}

run "rejects_a_tag_that_collides_with_the_tag_prefix_box_key" {
  command = plan
  variables {
    tag_prefix = "old"
    tags       = { "old:box" = "x" }
  }
  expect_failures = [var.tags]
}
