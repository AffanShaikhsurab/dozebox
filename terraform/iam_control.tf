# The control function's role: one customer-managed policy per concern (part 8 §8.2), attached in iam_index.tf. It
# starts, stops and launches only this box's machines, and never deletes a volume or a snapshot.
resource "aws_iam_role" "control" {
  name = local.names.control_role
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "LambdaOnly"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
  permissions_boundary = var.iam_permissions_boundary
  tags                 = local.tags
}

locals {
  # Shared secrets the control function reads: alert sinks and wake sources, by name.
  control_secret_names = sort(distinct(compact([
    var.alerts.ntfy_secret, var.alerts.webhook_secret, var.alerts.healthchecks_secret,
    try(var.wake_sources.github.secret, null), try(var.wake_sources.generic.secret, null),
  ])))

  launch_template_arns = [for lt in aws_launch_template.box : lt.arn]

  control_ec2_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "StartAndStopThisBoxPersistentInstance"
        Effect    = "Allow"
        Action    = ["ec2:StartInstances", "ec2:StopInstances"]
        Resource  = [local.arns.instances]
        Condition = { StringEquals = { (local.box_tag) = var.box_id, "aws:ResourceTag/${local.role_tag}" = "persistent" } }
      },
      {
        Sid      = "DriveOwnGroups"
        Effect   = "Allow"
        Action   = ["autoscaling:SetDesiredCapacity", "autoscaling:UpdateAutoScalingGroup", "autoscaling:LaunchInstances"]
        Resource = [local.arns.group, local.arns.fallback_group]
      },
      # Describe actions take no resource.
      {
        Sid       = "ReadMachines"
        Effect    = "Allow"
        Action    = ["autoscaling:DescribeAutoScalingGroups", "autoscaling:DescribeScalingActivities", "ec2:DescribeInstances", "ec2:DescribeInstanceStatus", "ec2:DescribeSpotInstanceRequests", "ec2:DescribeSpotPriceHistory"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = local.region } }
      },
      # A group launch is authorised against the launch template's resources: only this box's templates, its security
      # group and subnet, and the box role.
      {
        Sid      = "LaunchOnlyFromOwnTemplates"
        Effect   = "Allow"
        Action   = ["ec2:RunInstances"]
        Resource = concat(local.launch_template_arns, [aws_security_group.box.arn, "arn:${local.partition}:ec2:${local.region}:${local.account_id}:subnet/${local.subnet_id}", "arn:${local.partition}:ec2:${local.region}::image/*", local.arns.volumes, "arn:${local.partition}:ec2:${local.region}:${local.account_id}:network-interface/*"])
      },
      {
        Sid       = "LaunchInstancesOnlyThroughOwnTemplates"
        Effect    = "Allow"
        Action    = ["ec2:RunInstances"]
        Resource  = [local.arns.instances]
        Condition = { ArnEquals = { "ec2:LaunchTemplate" = local.launch_template_arns } }
      },
      {
        Sid       = "TagWhatALaunchCreates"
        Effect    = "Allow"
        Action    = ["ec2:CreateTags"]
        Resource  = ["arn:${local.partition}:ec2:${local.region}:${local.account_id}:*/*"]
        Condition = { StringEquals = { "ec2:CreateAction" = "RunInstances" } }
      },
      {
        Sid       = "PassOnlyTheBoxRoleToEc2"
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = [aws_iam_role.box.arn]
        Condition = { StringEquals = { "iam:PassedToService" = "ec2.amazonaws.com" } }
      },
    ]
  }

  control_volumes_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AttachAndDetachOnlyTheActiveDataVolume"
        Effect    = "Allow"
        Action    = ["ec2:AttachVolume", "ec2:DetachVolume"]
        Resource  = [local.arns.volumes]
        Condition = { StringEquals = { (local.box_tag) = var.box_id, "aws:ResourceTag/${local.tag_prefix}:active" = "true" } }
      },
      {
        Sid       = "AttachAndDetachOnlyThisBoxInstances"
        Effect    = "Allow"
        Action    = ["ec2:AttachVolume", "ec2:DetachVolume"]
        Resource  = [local.arns.instances]
        Condition = { StringEquals = { (local.box_tag) = var.box_id } }
      },
      {
        Sid       = "SnapshotOnlyTheActiveDataVolume"
        Effect    = "Allow"
        Action    = ["ec2:CreateSnapshot"]
        Resource  = [local.arns.volumes]
        Condition = { StringEquals = { (local.box_tag) = var.box_id, "aws:ResourceTag/${local.tag_prefix}:active" = "true" } }
      },
      # A new snapshot or volume must carry the box tag in the request, so nothing is created untagged.
      {
        Sid       = "CreateOnlyTaggedSnapshotsAndVolumes"
        Effect    = "Allow"
        Action    = ["ec2:CreateSnapshot", "ec2:CreateVolume"]
        Resource  = [local.arns.snapshots, local.arns.volumes]
        Condition = { StringEquals = { "aws:RequestTag/${local.tag_prefix}:box" = var.box_id } }
      },
      {
        Sid       = "RestoreOnlyFromOwnSnapshots"
        Effect    = "Allow"
        Action    = ["ec2:CreateVolume"]
        Resource  = [local.arns.snapshots]
        Condition = { StringEquals = { (local.box_tag) = var.box_id } }
      },
      {
        Sid       = "TagAtCreationOnly"
        Effect    = "Allow"
        Action    = ["ec2:CreateTags"]
        Resource  = [local.arns.snapshots, local.arns.volumes]
        Condition = { StringEquals = { "ec2:CreateAction" = ["CreateSnapshot", "CreateVolume"], "aws:RequestTag/${local.tag_prefix}:box" = var.box_id } }
      },
      {
        Sid       = "ReadVolumesAndSnapshots"
        Effect    = "Allow"
        Action    = ["ec2:DescribeVolumes", "ec2:DescribeSnapshots", "ec2:DescribeVolumeStatus"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = local.region } }
      },
    ]
  }

  control_records_policy = {
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid      = "ReadRecordsConfigTokenAndFreeze"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        Resource = [local.ssm_box_arn, "${local.ssm_box_arn}/rec/*", "${local.ssm_box_arn}/fence/*", "${local.ssm_box_arn}/config", "${local.ssm_box_arn}/payloads/*", "${local.ssm_box_arn}/wake-token", local.arns.freeze]
      },
      {
        Sid      = "ReadWriteIntents"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:PutParameter", "ssm:DeleteParameter"]
        Resource = ["${local.ssm_box_arn}/ctl/*"]
      },
      ], length(local.control_secret_names) == 0 ? [] : [{
        Sid      = "ReadNamedSharedSecrets"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = [for n in local.control_secret_names : "${local.ssm_shared_arn}/${n}"]
    }])
  }

  control_state_policy = {
    Version = "2012-10-17"
    Statement = [{
      Sid      = "OwnStateTable"
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:ConditionCheckItem", "dynamodb:BatchGetItem"]
      Resource = [local.arns.state_table, "${local.arns.state_table}/index/*"]
    }]
  }

  control_alerts_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "PublishToOwnAlertTopic"
        Effect   = "Allow"
        Action   = ["sns:Publish"]
        Resource = [local.arns.alert_topic]
      },
      {
        Sid      = "FailedInvokesToOwnQueue"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = [local.arns.control_dlq]
      },
      {
        Sid      = "WriteOwnLogGroup"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${local.arns.control_logs}:*"]
      },
    ]
  }

  control_spend_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadOwnBudget"
        Effect   = "Allow"
        Action   = ["budgets:ViewBudget"]
        Resource = [local.arns.budget]
      },
      # Cost Explorer and CloudWatch reads take no resource.
      {
        Sid      = "ReadSpendAndCapMetrics"
        Effect   = "Allow"
        Action   = ["ce:GetCostAndUsage", "cloudwatch:GetMetricData", "cloudwatch:GetMetricStatistics", "cloudwatch:DescribeAlarms"]
        Resource = "*"
      },
      {
        Sid       = "PutOwnMetrics"
        Effect    = "Allow"
        Action    = ["cloudwatch:PutMetricData"]
        Resource  = "*"
        Condition = { StringEquals = { "cloudwatch:namespace" = var.name_prefix } }
      },
    ]
  }
}

resource "aws_iam_policy" "control_ec2" {
  name        = "${local.names.control_role}-ec2"
  description = "Control ${var.box_id}: start, stop and launch this box's machines."
  policy      = jsonencode(local.control_ec2_policy)
  tags        = local.tags
}

resource "aws_iam_policy" "control_volumes" {
  name        = "${local.names.control_role}-volumes"
  description = "Control ${var.box_id}: attach, detach, snapshot and restore the active data volume. No deletes."
  policy      = jsonencode(local.control_volumes_policy)
  tags        = local.tags
}

resource "aws_iam_policy" "control_records" {
  name        = "${local.names.control_role}-records"
  description = "Control ${var.box_id}: read records, config and the freeze state; write intents."
  policy      = jsonencode(local.control_records_policy)
  tags        = local.tags
}

resource "aws_iam_policy" "control_state" {
  name        = "${local.names.control_role}-state"
  description = "Control ${var.box_id}: its DynamoDB state table."
  policy      = jsonencode(local.control_state_policy)
  tags        = local.tags
}

resource "aws_iam_policy" "control_alerts" {
  name        = "${local.names.control_role}-alerts"
  description = "Control ${var.box_id}: alert topic, dead-letter queue, own logs."
  policy      = jsonencode(local.control_alerts_policy)
  tags        = local.tags
}

resource "aws_iam_policy" "control_spend" {
  name        = "${local.names.control_role}-spend"
  description = "Control ${var.box_id}: read budget, spend and cap metrics; put own metrics."
  policy      = jsonencode(local.control_spend_policy)
  tags        = local.tags
}
