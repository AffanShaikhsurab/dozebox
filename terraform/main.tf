data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.region

  # Every name, SSM path and tag key starts with the prefix, so two prefixes never collide in one account (ADR 0009).
  tag_prefix = var.name_prefix
  name       = "${var.name_prefix}-${var.box_id}"
  tags       = merge(var.tags, { "${local.tag_prefix}:box" = var.box_id })

  ssm_prefix     = "/${var.name_prefix}/${var.box_id}/"
  ssm_box_arn    = "arn:${local.partition}:ssm:${local.region}:${local.account_id}:parameter/${var.name_prefix}/${var.box_id}"
  ssm_shared_arn = "arn:${local.partition}:ssm:${local.region}:${local.account_id}:parameter/${var.name_prefix}/shared"

  # Names every file of the module builds on. A policy names a resource by these, not by a resource reference, so a
  # policy never waits on (or cycles with) the resource it scopes.
  names = {
    group             = local.name
    fallback_group    = "${local.name}-od"
    launch_template   = local.name
    data_volume       = "${local.name}-data"
    control_function  = "${local.name}-control"
    state_table       = local.name
    alert_topic       = "${local.name}-alerts"
    box_log_group     = "/${var.name_prefix}/${var.box_id}/box"
    control_log_group = "/aws/lambda/${local.name}-control"
    dashboard         = local.name
    budget            = "${local.name}-monthly"
    box_role          = "${local.name}-box"
    control_role      = "${local.name}-control"
    kill_role         = "${local.name}-kill"
    unfreeze_role     = "${local.name}-unfreeze"
    scheduler_role    = "${local.name}-scheduler"
    snapshots_role    = "${local.name}-snapshots"
    deny_policy       = "${local.name}-frozen"
    control_dlq       = "${local.name}-control-dlq"
    freeze_parameter  = "${local.ssm_prefix}freeze"
  }

  arns = {
    group          = "arn:${local.partition}:autoscaling:${local.region}:${local.account_id}:autoScalingGroup:*:autoScalingGroupName/${local.names.group}"
    fallback_group = "arn:${local.partition}:autoscaling:${local.region}:${local.account_id}:autoScalingGroup:*:autoScalingGroupName/${local.names.fallback_group}"
    instances      = "arn:${local.partition}:ec2:${local.region}:${local.account_id}:instance/*"
    volumes        = "arn:${local.partition}:ec2:${local.region}:${local.account_id}:volume/*"
    snapshots      = "arn:${local.partition}:ec2:${local.region}::snapshot/*"
    state_table    = "arn:${local.partition}:dynamodb:${local.region}:${local.account_id}:table/${local.names.state_table}"
    alert_topic    = "arn:${local.partition}:sns:${local.region}:${local.account_id}:${local.names.alert_topic}"
    box_logs       = "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:${local.names.box_log_group}"
    control_logs   = "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:${local.names.control_log_group}"
    control_fn     = "arn:${local.partition}:lambda:${local.region}:${local.account_id}:function:${local.names.control_function}"
    control_dlq    = "arn:${local.partition}:sqs:${local.region}:${local.account_id}:${local.names.control_dlq}"
    deny_policy    = "arn:${local.partition}:iam::${local.account_id}:policy/${local.names.deny_policy}"
    budget         = "arn:${local.partition}:budgets::${local.account_id}:budget/${local.names.budget}"
    freeze         = "${local.ssm_box_arn}/freeze"
  }

  ami_ssm_parameter = coalesce(
    var.instance.ami_ssm_parameter,
    "/aws/service/canonical/ubuntu/server/24.04/stable/current/${var.instance.arch == "arm64" ? "arm64" : "amd64"}/hvm/ebs-gp3/ami-id",
  )

  # Shared secrets the box may read: the names the payload definitions ask for, never /<prefix>/shared/*.
  payload_secret_names = sort(distinct(flatten([
    for p in values(var.payloads) : [for s in try(p.secrets, []) : s.name]
  ])))
}

check "an_alert_path_is_set" {
  assert {
    condition     = var.alerts.email != null || var.alerts.ntfy_secret != null || var.alerts.web_push
    error_message = "No alert path: set alerts.email, alerts.ntfy_secret or alerts.web_push, or nobody hears a cap or a failure."
  }
}
