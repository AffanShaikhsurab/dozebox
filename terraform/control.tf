# The control function (part 3): one Lambda, alias `live`, behind a Function URL. With the front door on the URL is
# AWS_IAM (CloudFront OAC signs); with it off the URL is public and the wake token is the only gate. A one-minute
# Scheduler tick and two EC2 event rules invoke the same alias. Every asynchronous invoke gets one retry, then goes
# to the dead-letter queue. The role's policies are T2's (iam_control.tf); this file names nothing they scope.
locals {
  # The bundle: control_bundle_path (a zip with control.mjs exporting handler), or the placeholder that answers 503.
  control_placeholder = var.control_bundle_path == null
  control_zip         = local.control_placeholder ? data.archive_file.control_placeholder[0].output_path : var.control_bundle_path
  control_zip_hash    = local.control_placeholder ? data.archive_file.control_placeholder[0].output_base64sha256 : filebase64sha256(var.control_bundle_path)

  # With the front door on, only CloudFront (OAC signs with SigV4) and IAM callers reach the URL.
  control_url_auth = var.front_door_enabled ? "AWS_IAM" : "NONE"

  # Everything the control function needs to find its stack, as one JSON value (DOZEBOX_CONTROL). Names, never
  # resource ids that change on rebuild; the caps come from caps.tf.
  control_config = {
    v             = 1
    box           = { id = var.box_id, prefix = var.name_prefix, region = local.region }
    ssmPrefix     = local.ssm_prefix
    stateTable    = local.names.state_table
    alertTopicArn = local.arns.alert_topic
    groups        = local.cap_group_names
    metrics       = { namespace = local.metric_namespace }
    caps          = local.caps_config
    fallback      = { enabled = var.fallback.enabled, unattended = var.fallback.unattended }
    wakeBudget    = { perHour = var.wake_budget.per_hour, perDay = var.wake_budget.per_day }
    kill          = local.kill_config
  }

  # EC2 sends these for every instance in the account and region, without tags; the function keeps the events for
  # its own instances (looked up by the <prefix>:box tag) and drops the rest.
  control_event_rules = {
    ec2-state = {
      source        = ["aws.ec2"]
      "detail-type" = ["EC2 Instance State-change Notification"]
      detail        = { state = ["running", "stopping", "stopped", "terminated"] }
    }
    spot-warning = {
      source        = ["aws.ec2"]
      "detail-type" = ["EC2 Spot Instance Interruption Warning"]
    }
  }
}

data "archive_file" "control_placeholder" {
  count = local.control_placeholder ? 1 : 0

  type        = "zip"
  source_file = "${path.module}/control/control.mjs"
  output_path = "${path.root}/.terraform/${local.names.control_function}-placeholder.zip"
}

resource "aws_sqs_queue" "control_dlq" {
  name                      = local.names.control_dlq
  message_retention_seconds = 1209600 # 14 days, the SQS maximum
  sqs_managed_sse_enabled   = true
  tags                      = local.tags
}

resource "aws_lambda_function" "control" {
  function_name                  = local.names.control_function
  description                    = "dozebox control function for ${var.box_id}"
  role                           = aws_iam_role.control.arn
  runtime                        = "nodejs26.x"
  architectures                  = ["arm64"]
  handler                        = "control.handler"
  filename                       = local.control_zip
  source_code_hash               = local.control_zip_hash
  memory_size                    = 512 # 128 MB took 13 to 15 s to cold start, 256 MB 7 s (notes/c3t)
  timeout                        = 30
  reserved_concurrent_executions = 2
  publish                        = true # the alias points at a published version, never $LATEST

  environment {
    variables = {
      DOZEBOX_BOX_ID  = var.box_id
      DOZEBOX_CONTROL = jsonencode(local.control_config)
    }
  }

  tags       = local.tags
  depends_on = [aws_cloudwatch_log_group.control]
}

resource "aws_lambda_alias" "live" {
  name             = "live"
  description      = "The version every caller invokes."
  function_name    = aws_lambda_function.control.function_name
  function_version = aws_lambda_function.control.version
}

# No cors block: the handler answers preflights itself (a cors block too doubled the allow-origin header, notes/c3t).
resource "aws_lambda_function_url" "control" {
  function_name      = aws_lambda_function.control.function_name
  qualifier          = aws_lambda_alias.live.name
  authorization_type = local.control_url_auth
}

# Without the front door the URL is public and the wake token is the gate. Since October 2025 a public URL needs both
# statements (notes/06b §1.1); the second is limited to calls that come through the URL.
resource "aws_lambda_permission" "control_url_public" {
  count = local.control_url_auth == "NONE" ? 1 : 0

  statement_id           = "AllowPublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.control.function_name
  qualifier              = aws_lambda_alias.live.name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "control_url_invoke" {
  count = local.control_url_auth == "NONE" ? 1 : 0

  statement_id             = "AllowPublicInvokeViaFunctionUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.control.function_name
  qualifier                = aws_lambda_alias.live.name
  principal                = "*"
  invoked_via_function_url = true
}

# One retry, and events older than 3 minutes are dropped: the next tick redoes the work. Lambda checks the role may
# send to the queue when this is written, so it waits for the managed policy attachments.
resource "aws_lambda_function_event_invoke_config" "control" {
  function_name                = aws_lambda_function.control.function_name
  qualifier                    = aws_lambda_alias.live.name
  maximum_retry_attempts       = 1
  maximum_event_age_in_seconds = 180

  destination_config {
    on_failure {
      destination = aws_sqs_queue.control_dlq.arn
    }
  }

  depends_on = [aws_iam_role_policy_attachment.managed]
}

# Schedules take no tags; their group does.
resource "aws_scheduler_schedule_group" "box" {
  name = local.name
  tags = local.tags
}

resource "aws_scheduler_schedule" "reconcile" {
  name                = "${local.name}-reconcile"
  group_name          = aws_scheduler_schedule_group.box.name
  schedule_expression = "rate(1 minute)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_alias.live.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ dozebox = "reconcile", v = 1 })

    # The tick is its own retry: a missed one is redone a minute later.
    retry_policy {
      maximum_retry_attempts       = 0
      maximum_event_age_in_seconds = 60
    }
  }
}

resource "aws_cloudwatch_event_rule" "control" {
  for_each = local.control_event_rules

  name          = "${local.name}-${each.key}"
  description   = "EC2 events for the ${var.box_id} control function."
  event_pattern = jsonencode(each.value)
  tags          = local.tags
}

resource "aws_cloudwatch_event_target" "control" {
  for_each = local.control_event_rules

  rule = aws_cloudwatch_event_rule.control[each.key].name
  arn  = aws_lambda_alias.live.arn
}

resource "aws_lambda_permission" "control_events" {
  for_each = local.control_event_rules

  statement_id  = "AllowRule-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.control.function_name
  qualifier     = aws_lambda_alias.live.name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.control[each.key].arn
}
