# The instance role of the box: one customer-managed policy per concern (part 8 §8.2), attached in iam_index.tf.
# Every process on the box can use these credentials, so the box writes only its own records and never starts,
# launches, or touches IAM. AmazonSSMManagedInstanceCore is not attached: it reads every parameter in the account.
resource "aws_iam_role" "box" {
  name = local.names.box_role
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "Ec2Only"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
  permissions_boundary = var.iam_permissions_boundary
  tags                 = local.tags
}

resource "aws_iam_instance_profile" "box" {
  name = local.names.box_role
  role = aws_iam_role.box.name
  tags = local.tags
}

locals {
  box_tag = "aws:ResourceTag/${local.tag_prefix}:box"

  box_records_policy = {
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid      = "WriteOwnRecords"
        Effect   = "Allow"
        Action   = ["ssm:PutParameter", "ssm:DeleteParameter"]
        Resource = ["${local.ssm_box_arn}/rec/*", "${local.ssm_box_arn}/fence/*"]
      },
      {
        Sid      = "ReadConfigIntentsAndRecords"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = ["${local.ssm_box_arn}/config", "${local.ssm_box_arn}/payloads/*", "${local.ssm_box_arn}/ctl/*", "${local.ssm_box_arn}/rec/*", "${local.ssm_box_arn}/fence/*", "${local.ssm_box_arn}/wake-token"]
      },
      ], length(local.payload_secret_names) == 0 ? [] : [{
        # Named one by one from the payload definitions, never /<prefix>/shared/*, never writable from the box.
        Sid      = "ReadNamedSharedSecrets"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = [for n in local.payload_secret_names : "${local.ssm_shared_arn}/${n}"]
    }])
  }

  box_compute_policy = {
    Version = "2012-10-17"
    Statement = [
      # AttachVolume is authorised against the volume and the instance, so one statement per resource type. The volume
      # side is the fence: only the box's volume tagged active.
      {
        Sid       = "AttachOnlyTheActiveDataVolume"
        Effect    = "Allow"
        Action    = ["ec2:AttachVolume"]
        Resource  = [local.arns.volumes]
        Condition = { StringEquals = { (local.box_tag) = var.box_id, "aws:ResourceTag/${local.tag_prefix}:active" = "true" } }
      },
      {
        Sid       = "AttachOnlyToThisBoxInstances"
        Effect    = "Allow"
        Action    = ["ec2:AttachVolume"]
        Resource  = [local.arns.instances]
        Condition = { StringEquals = { (local.box_tag) = var.box_id } }
      },
      # A persistent box parks by stopping itself; the agent also compares the target id with IMDS instance-id.
      {
        Sid       = "StopOnlyThisBoxPersistentInstance"
        Effect    = "Allow"
        Action    = ["ec2:StopInstances"]
        Resource  = [local.arns.instances]
        Condition = { StringEquals = { (local.box_tag) = var.box_id, "aws:ResourceTag/${local.role_tag}" = "persistent" } }
      },
      {
        Sid      = "ParkOwnGroupsToZero"
        Effect   = "Allow"
        Action   = ["autoscaling:SetDesiredCapacity"]
        Resource = [local.arns.group, local.arns.fallback_group]
      },
      # Describe takes no resource. DescribeInstances is left out: it would list every instance in the account, and the
      # agent reads its own facts from IMDS.
      {
        Sid       = "SeeVolumesAndGroups"
        Effect    = "Allow"
        Action    = ["ec2:DescribeVolumes", "autoscaling:DescribeAutoScalingGroups"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = local.region } }
      },
    ]
  }

  box_alerts_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "PublishToOwnAlertTopic"
        Effect   = "Allow"
        Action   = ["sns:Publish"]
        Resource = [local.arns.alert_topic]
      },
      # Publish is all it may do: a box process that could re-policy or delete the topic could silence every alert.
      {
        Sid      = "NeverAdministerTheAlertTopic"
        Effect   = "Deny"
        Action   = ["sns:Subscribe", "sns:Unsubscribe", "sns:SetTopicAttributes", "sns:SetSubscriptionAttributes", "sns:DeleteTopic", "sns:AddPermission", "sns:RemovePermission"]
        Resource = [local.arns.alert_topic]
      },
    ]
  }

  box_logs_policy = {
    Version = "2012-10-17"
    Statement = [{
      Sid      = "WriteOwnLogGroup"
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = ["${local.arns.box_logs}:*"]
    }]
  }

  # Only the calls the SSM agent needs to register and open a session channel; none reads a parameter.
  box_ssm_session_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "RegisterWithSessionManager"
        Effect   = "Allow"
        Action   = ["ssm:UpdateInstanceInformation", "ssm:ListInstanceAssociations", "ssm:DescribeInstanceProperties"]
        Resource = "*"
      },
      {
        Sid      = "OpenSessionChannels"
        Effect   = "Allow"
        Action   = ["ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"]
        Resource = "*"
      },
      {
        Sid      = "ReceiveRunCommand"
        Effect   = "Allow"
        Action   = ["ec2messages:AcknowledgeMessage", "ec2messages:DeleteMessage", "ec2messages:FailMessage", "ec2messages:GetEndpoint", "ec2messages:GetMessages", "ec2messages:SendReply"]
        Resource = "*"
      },
    ]
  }
}

resource "aws_iam_policy" "box_records" {
  name        = "${local.names.box_role}-records"
  description = "Box ${var.box_id}: write own records, read config, intents and named shared secrets."
  policy      = jsonencode(local.box_records_policy)
  tags        = local.tags
}

resource "aws_iam_policy" "box_compute" {
  name        = "${local.names.box_role}-compute"
  description = "Box ${var.box_id}: attach the active data volume, stop itself, park its groups."
  policy      = jsonencode(local.box_compute_policy)
  tags        = local.tags
}

resource "aws_iam_policy" "box_alerts" {
  name        = "${local.names.box_role}-alerts"
  description = "Box ${var.box_id}: publish to its alert topic only."
  policy      = jsonencode(local.box_alerts_policy)
  tags        = local.tags
}

resource "aws_iam_policy" "box_logs" {
  name        = "${local.names.box_role}-logs"
  description = "Box ${var.box_id}: write its own log group."
  policy      = jsonencode(local.box_logs_policy)
  tags        = local.tags
}

resource "aws_iam_policy" "box_ssm_session" {
  count       = var.enable_ssm_session ? 1 : 0
  name        = "${local.names.box_role}-ssm-session"
  description = "Box ${var.box_id}: Session Manager and Run Command channels, no parameter reads."
  policy      = jsonencode(local.box_ssm_session_policy)
  tags        = local.tags
}
