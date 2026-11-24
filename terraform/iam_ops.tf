# Roles that AWS services assume for the module: the kill and unfreeze runbooks (SSM Automation), the reconcile
# schedule (EventBridge Scheduler) and DLM. Their managed policies are attached in this file by WP-T2.
locals {
  service_trust = {
    for svc in ["ssm", "scheduler", "dlm"] : svc => jsonencode({
      Version = "2012-10-17"
      Statement = [{
        Sid       = "ServiceOnly"
        Effect    = "Allow"
        Principal = { Service = "${svc}.amazonaws.com" }
        Action    = "sts:AssumeRole"
        Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
      }]
    })
  }
}

resource "aws_iam_role" "kill" {
  name               = local.names.kill_role
  assume_role_policy = local.service_trust["ssm"]
  tags               = local.tags
}

resource "aws_iam_role" "unfreeze" {
  name               = local.names.unfreeze_role
  assume_role_policy = local.service_trust["ssm"]
  tags               = local.tags
}

resource "aws_iam_role" "scheduler" {
  name               = local.names.scheduler_role
  assume_role_policy = local.service_trust["scheduler"]
  tags               = local.tags
}

resource "aws_iam_role" "snapshots" {
  name               = local.names.snapshots_role
  assume_role_policy = local.service_trust["dlm"]
  tags               = local.tags
}
