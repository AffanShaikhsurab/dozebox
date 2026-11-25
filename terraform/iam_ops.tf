# Roles that AWS services assume for the module: the kill and unfreeze runbooks (SSM Automation), the reconcile
# schedule (EventBridge Scheduler) and DLM. One managed policy each, attached in iam_index.tf.
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

  # Both runbooks touch the deny policy only on the box and control roles, and only that one policy.
  deny_policy_condition = { ArnEquals = { "iam:PolicyARN" = local.arns.deny_policy } }
  frozen_roles          = [aws_iam_role.box.arn, aws_iam_role.control.arn]

  kill_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AttachTheDenyPolicy"
        Effect    = "Allow"
        Action    = ["iam:AttachRolePolicy"]
        Resource  = local.frozen_roles
        Condition = local.deny_policy_condition
      },
      {
        Sid       = "StopThisBoxInstances"
        Effect    = "Allow"
        Action    = ["ec2:StopInstances"]
        Resource  = [local.arns.instances]
        Condition = { StringEquals = { (local.box_tag) = var.box_id } }
      },
      {
        Sid      = "ZeroThisBoxGroups"
        Effect   = "Allow"
        Action   = ["autoscaling:SetDesiredCapacity"]
        Resource = [local.arns.group, local.arns.fallback_group]
      },
      {
        Sid       = "SeeInstancesAndGroups"
        Effect    = "Allow"
        Action    = ["ec2:DescribeInstances", "autoscaling:DescribeAutoScalingGroups"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = local.region } }
      },
      {
        Sid      = "RecordTheFreeze"
        Effect   = "Allow"
        Action   = ["ssm:PutParameter", "ssm:GetParameter"]
        Resource = [local.arns.freeze]
      },
    ]
  }

  unfreeze_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DetachTheDenyPolicy"
        Effect    = "Allow"
        Action    = ["iam:DetachRolePolicy"]
        Resource  = local.frozen_roles
        Condition = local.deny_policy_condition
      },
      {
        Sid      = "ClearTheFreeze"
        Effect   = "Allow"
        Action   = ["ssm:PutParameter", "ssm:GetParameter", "ssm:DeleteParameter"]
        Resource = [local.arns.freeze]
      },
    ]
  }

  scheduler_policy = {
    Version = "2012-10-17"
    Statement = [{
      Sid      = "InvokeOnlyTheControlFunction"
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [local.arns.control_fn, "${local.arns.control_fn}:*"]
    }]
  }

  # The action list of AWSDataLifecycleManagerServiceRole, without fast snapshot restore and sharing.
  snapshots_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "SnapshotTargetedVolumes"
        Effect   = "Allow"
        Action   = ["ec2:CreateSnapshot", "ec2:CreateSnapshots", "ec2:DeleteSnapshot", "ec2:DescribeInstances", "ec2:DescribeVolumes", "ec2:DescribeSnapshots"]
        Resource = "*"
      },
      {
        Sid      = "TagSnapshotsItCreates"
        Effect   = "Allow"
        Action   = ["ec2:CreateTags", "ec2:DeleteTags"]
        Resource = [local.arns.snapshots]
      },
    ]
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

resource "aws_iam_policy" "kill" {
  name        = local.names.kill_role
  description = "Kill ${var.box_id}: attach the deny policy, stop the box, zero its groups."
  policy      = jsonencode(local.kill_policy)
  tags        = local.tags
}

resource "aws_iam_policy" "unfreeze" {
  name        = local.names.unfreeze_role
  description = "Unfreeze ${var.box_id}: detach the deny policy only."
  policy      = jsonencode(local.unfreeze_policy)
  tags        = local.tags
}

resource "aws_iam_policy" "scheduler" {
  name        = local.names.scheduler_role
  description = "Scheduler ${var.box_id}: invoke the control function."
  policy      = jsonencode(local.scheduler_policy)
  tags        = local.tags
}

resource "aws_iam_policy" "snapshots" {
  name        = local.names.snapshots_role
  description = "DLM ${var.box_id}: snapshot targeted volumes."
  policy      = jsonencode(local.snapshots_policy)
  tags        = local.tags
}
