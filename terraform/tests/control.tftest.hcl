# The control function, its alias, URL, tick, event rules and dead-letter queue (WP-T4), and the state table.
# Offline: the AWS provider is mocked; ARNs the assertions compare are overridden with real-shaped values.
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
  caps        = { monthly_budget_usd = 10, awake_hours_per_day = 4 }
  payloads = {
    demo = { schema = 1, name = "demo", user = "demo", protocol = "none", start = { command = ["/bin/true"] } }
  }
  agent = { version = "none" }
}

run "control_plane" {
  command = apply

  assert {
    condition     = aws_lambda_function.control.function_name == "dozebox-main-control" && aws_lambda_function.control.runtime == "nodejs26.x"
    error_message = "The control function is <prefix>-<box>-control on nodejs26.x."
  }
  assert {
    condition     = aws_lambda_function.control.architectures == tolist(["arm64"]) && aws_lambda_function.control.handler == "control.handler"
    error_message = "arm64, handler control.handler (dist/control.mjs of the bundle)."
  }
  assert {
    condition     = aws_lambda_function.control.reserved_concurrent_executions == 2 && aws_lambda_function.control.publish
    error_message = "Reserved concurrency 2, and every deploy publishes a version for the alias."
  }
  assert {
    condition     = aws_lambda_function.control.role == aws_iam_role.control.arn
    error_message = "The function runs as the control role."
  }
  assert {
    condition     = aws_lambda_alias.live.name == "live" && aws_lambda_alias.live.function_version == "3"
    error_message = "Alias live points at the published version, not $LATEST."
  }
  assert {
    condition     = aws_lambda_function_url.control.authorization_type == "AWS_IAM" && aws_lambda_function_url.control.qualifier == "live"
    error_message = "With the front door on (default) the Function URL is AWS_IAM, on the alias."
  }
  assert {
    condition     = length(aws_lambda_permission.control_url_public) == 0 && length(aws_lambda_permission.control_url_invoke) == 0
    error_message = "With the front door on nothing makes the URL public."
  }
  assert {
    condition     = length(aws_lambda_function_url.control.cors) == 0
    error_message = "No cors block: the handler answers preflights itself."
  }
}

run "front_door_off_makes_the_url_public_and_the_token_the_gate" {
  command = apply
  variables {
    front_door_enabled = false
  }

  assert {
    condition     = aws_lambda_function_url.control.authorization_type == "NONE"
    error_message = "Without the front door the URL is NONE (the phase 2 exit calls it with curl and the wake token)."
  }
  assert {
    condition = (aws_lambda_permission.control_url_public[0].action == "lambda:InvokeFunctionUrl" && aws_lambda_permission.control_url_public[0].function_url_auth_type == "NONE"
    && aws_lambda_permission.control_url_public[0].qualifier == "live")
    error_message = "A public URL needs lambda:InvokeFunctionUrl for NONE on the alias."
  }
  assert {
    condition     = aws_lambda_permission.control_url_invoke[0].action == "lambda:InvokeFunction" && aws_lambda_permission.control_url_invoke[0].invoked_via_function_url
    error_message = "And lambda:InvokeFunction, only through the URL (the October 2025 rule)."
  }
}

run "the_schedule_ticks_every_minute_on_the_alias" {
  command = apply

  assert {
    condition     = aws_scheduler_schedule.reconcile.schedule_expression == "rate(1 minute)" && aws_scheduler_schedule.reconcile.flexible_time_window[0].mode == "OFF"
    error_message = "The reconcile tick runs every minute with no flexible window."
  }
  assert {
    condition     = aws_scheduler_schedule.reconcile.target[0].arn == aws_lambda_alias.live.arn && endswith(aws_scheduler_schedule.reconcile.target[0].arn, ":live")
    error_message = "The schedule targets alias live, never $LATEST or the bare function."
  }
  assert {
    condition     = aws_scheduler_schedule.reconcile.target[0].role_arn == aws_iam_role.scheduler.arn
    error_message = "The schedule uses the scheduler role."
  }
  assert {
    condition     = jsondecode(aws_scheduler_schedule.reconcile.target[0].input) == { dozebox = "reconcile", v = 1 }
    error_message = "The tick sends the reconcile event."
  }
  assert {
    condition     = aws_scheduler_schedule.reconcile.target[0].retry_policy[0].maximum_retry_attempts == 0
    error_message = "The tick is its own retry."
  }
  assert {
    condition     = aws_scheduler_schedule.reconcile.group_name == "dozebox-main" && aws_scheduler_schedule_group.box.tags["dozebox:box"] == "main"
    error_message = "The schedule sits in the box's tagged schedule group."
  }
}

run "ec2_events_reach_the_alias" {
  command = apply

  assert {
    condition     = toset(keys(aws_cloudwatch_event_rule.control)) == toset(["ec2-state", "spot-warning"])
    error_message = "One rule for EC2 state changes and one for Spot interruption warnings."
  }
  assert {
    condition     = jsondecode(aws_cloudwatch_event_rule.control["spot-warning"].event_pattern)["detail-type"] == ["EC2 Spot Instance Interruption Warning"]
    error_message = "The Spot rule matches the two-minute warning."
  }
  assert {
    condition     = contains(jsondecode(aws_cloudwatch_event_rule.control["ec2-state"].event_pattern).detail.state, "stopped")
    error_message = "The state rule sees stops (a reclaim frees the volume at once)."
  }
  assert {
    condition     = alltrue([for t in aws_cloudwatch_event_target.control : t.arn == aws_lambda_alias.live.arn])
    error_message = "Both rules invoke alias live."
  }
  assert {
    condition = alltrue([for k, p in { "ec2-state" = aws_lambda_permission.control_events_state, "spot-warning" = aws_lambda_permission.control_events_spot } :
    p.qualifier == "live" && p.principal == "events.amazonaws.com" && p.source_arn == aws_cloudwatch_event_rule.control[k].arn])
    error_message = "Each rule may invoke the alias, and only that rule (source_arn)."
  }
}

run "failed_invokes_are_retried_once_then_queued" {
  command = apply

  assert {
    condition     = aws_lambda_function_event_invoke_config.control.maximum_retry_attempts == 1 && aws_lambda_function_event_invoke_config.control.qualifier == "live"
    error_message = "Asynchronous invokes of the alias get one retry."
  }
  assert {
    condition     = aws_lambda_function_event_invoke_config.control.destination_config[0].on_failure[0].destination == aws_sqs_queue.control_dlq.arn
    error_message = "A failed invoke lands in the dead-letter queue."
  }
  assert {
    condition     = aws_sqs_queue.control_dlq.name == "dozebox-main-control-dlq" && aws_sqs_queue.control_dlq.arn == local.arns.control_dlq
    error_message = "The queue has the name the control role's policy scopes (local.arns.control_dlq)."
  }
  assert {
    condition     = aws_sqs_queue.control_dlq.sqs_managed_sse_enabled && aws_sqs_queue.control_dlq.message_retention_seconds == 1209600
    error_message = "The queue is encrypted and keeps failures 14 days."
  }
}

run "the_state_table_is_on_demand_with_ttl_and_no_pitr" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.state.name == "dozebox-main" && aws_dynamodb_table.state.billing_mode == "PAY_PER_REQUEST"
    error_message = "One on-demand table per stack, named as local.names.state_table."
  }
  assert {
    condition     = aws_dynamodb_table.state.hash_key == "pk" && aws_dynamodb_table.state.range_key == null && length(aws_dynamodb_table.state.attribute) == 1
    error_message = "One key, pk = <kind>#<id> (one table per stack; the phase 2 exit reads pk = lease#reconcile)."
  }
  assert {
    condition     = aws_dynamodb_table.state.ttl[0].attribute_name == "purgeAt" && aws_dynamodb_table.state.ttl[0].enabled
    error_message = "TTL on purgeAt (epoch seconds)."
  }
  assert {
    condition     = !aws_dynamodb_table.state.point_in_time_recovery[0].enabled
    error_message = "Point-in-time recovery is off."
  }
  assert {
    condition     = output.state_table_name == aws_dynamodb_table.state.name
    error_message = "state_table_name names the table."
  }
}

run "the_function_is_told_its_stack" {
  command = plan

  assert {
    condition     = jsondecode(aws_lambda_function.control.environment[0].variables.DOZEBOX_CONTROL).stateTable == "dozebox-main"
    error_message = "DOZEBOX_CONTROL names the state table."
  }
  assert {
    condition     = jsondecode(aws_lambda_function.control.environment[0].variables.DOZEBOX_CONTROL).caps.awakeHoursPerDay == 4
    error_message = "DOZEBOX_CONTROL carries the caps."
  }
  assert {
    condition     = jsondecode(aws_lambda_function.control.environment[0].variables.DOZEBOX_CONTROL).groups == { spot = null, fallback = "dozebox-main-od" }
    error_message = "A persistent box with fallback names only the fallback group."
  }
  assert {
    condition     = length(aws_lambda_function.control.environment[0].variables.DOZEBOX_CONTROL) < 3000
    error_message = "DOZEBOX_CONTROL leaves room under Lambda's 4 KB environment limit."
  }
  assert {
    condition     = aws_cloudwatch_log_group.control.name == "/aws/lambda/dozebox-main-control"
    error_message = "The function's log group exists before it, with the module's retention."
  }
}

run "without_a_bundle_the_placeholder_is_deployed" {
  command = plan

  assert {
    condition     = endswith(aws_lambda_function.control.filename, "dozebox-main-control-placeholder.zip") && length(data.archive_file.control_placeholder) == 1
    error_message = "control_bundle_path = null deploys the placeholder zip."
  }
}

run "a_bundle_replaces_the_placeholder" {
  command = plan
  variables {
    control_bundle_path = "tests/fixtures/control-bundle.zip"
  }

  assert {
    condition     = aws_lambda_function.control.filename == "tests/fixtures/control-bundle.zip" && length(data.archive_file.control_placeholder) == 0
    error_message = "control_bundle_path is deployed as given."
  }
  assert {
    condition     = aws_lambda_function.control.source_code_hash == filebase64sha256("tests/fixtures/control-bundle.zip")
    error_message = "A new bundle changes the hash, so the function updates."
  }
}

run "rejects_bundle_that_is_not_a_zip" {
  command = plan
  variables {
    control_bundle_path = "dist/control.mjs"
  }
  expect_failures = [var.control_bundle_path]
}

run "rejects_boundary_that_is_not_a_policy_arn" {
  command = plan
  variables {
    iam_permissions_boundary = "dozebox-test-boundary"
  }
  expect_failures = [var.iam_permissions_boundary]
}
