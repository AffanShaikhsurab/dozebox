# The deploy principal's managed policies, one per concern, each under IAM's 6,144 characters
# (tests/deploy_policies.tftest.hcl). Named resources are scoped to <prefix>-*; EC2 and Auto Scaling create calls
# accept no name, so they are scoped to the region. The principal manages the module's own managed policies
# (the I-13 lesson: no inline policies) and may never put an inline one.
locals {
  p      = var.name_prefix
  arn    = "arn:${local.partition}"
  in_reg = { StringEquals = { "aws:RequestedRegion" = var.region } }

  deploy_policies = {
    iam = {
      Version = "2012-10-17"
      Statement = [
        {
          Sid      = "ManageStackRoles"
          Effect   = "Allow"
          Action   = ["iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:UpdateRole", "iam:UpdateAssumeRolePolicy", "iam:TagRole", "iam:UntagRole", "iam:ListRoleTags", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary"]
          Resource = ["${local.arn}:iam::${local.account_id}:role/${local.p}-*"]
        },
        {
          Sid      = "ManageStackPolicies"
          Effect   = "Allow"
          Action   = ["iam:CreatePolicy", "iam:DeletePolicy", "iam:GetPolicy", "iam:CreatePolicyVersion", "iam:DeletePolicyVersion", "iam:GetPolicyVersion", "iam:ListPolicyVersions", "iam:SetDefaultPolicyVersion", "iam:TagPolicy", "iam:UntagPolicy", "iam:ListPolicyTags", "iam:ListEntitiesForPolicy"]
          Resource = ["${local.arn}:iam::${local.account_id}:policy/${local.p}-*"]
        },
        {
          Sid       = "AttachOnlyStackPolicies"
          Effect    = "Allow"
          Action    = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"]
          Resource  = ["${local.arn}:iam::${local.account_id}:role/${local.p}-*"]
          Condition = { ArnLike = { "iam:PolicyARN" = "${local.arn}:iam::${local.account_id}:policy/${local.p}-*" } }
        },
        {
          Sid      = "ManageStackInstanceProfiles"
          Effect   = "Allow"
          Action   = ["iam:CreateInstanceProfile", "iam:DeleteInstanceProfile", "iam:GetInstanceProfile", "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile", "iam:TagInstanceProfile", "iam:UntagInstanceProfile", "iam:ListInstanceProfileTags"]
          Resource = ["${local.arn}:iam::${local.account_id}:instance-profile/${local.p}-*"]
        },
        {
          Sid       = "PassStackRolesToTheirServices"
          Effect    = "Allow"
          Action    = ["iam:PassRole"]
          Resource  = ["${local.arn}:iam::${local.account_id}:role/${local.p}-*"]
          Condition = { StringEquals = { "iam:PassedToService" = ["ec2.amazonaws.com", "lambda.amazonaws.com", "dlm.amazonaws.com", "scheduler.amazonaws.com", "ssm.amazonaws.com", "events.amazonaws.com"] } }
        },
        {
          Sid       = "CreateServiceLinkedRoles"
          Effect    = "Allow"
          Action    = ["iam:CreateServiceLinkedRole"]
          Resource  = ["${local.arn}:iam::${local.account_id}:role/aws-service-role/*"]
          Condition = { StringEquals = { "iam:AWSServiceName" = ["autoscaling.amazonaws.com", "spot.amazonaws.com"] } }
        },
        {
          Sid      = "NeverInlinePolicies"
          Effect   = "Deny"
          Action   = ["iam:PutRolePolicy", "iam:PutUserPolicy", "iam:PutGroupPolicy"]
          Resource = "*"
        },
      ]
    }

    compute = {
      Version = "2012-10-17"
      Statement = [
        {
          Sid       = "ReadEc2AndGroups"
          Effect    = "Allow"
          Action    = ["ec2:Describe*", "ec2:GetLaunchTemplateData", "autoscaling:Describe*"]
          Resource  = "*"
          Condition = local.in_reg
        },
        {
          Sid    = "ManageNetwork"
          Effect = "Allow"
          Action = [
            "ec2:CreateVpc", "ec2:DeleteVpc", "ec2:ModifyVpcAttribute", "ec2:CreateSubnet", "ec2:DeleteSubnet", "ec2:ModifySubnetAttribute",
            "ec2:CreateInternetGateway", "ec2:DeleteInternetGateway", "ec2:AttachInternetGateway", "ec2:DetachInternetGateway",
            "ec2:CreateRouteTable", "ec2:DeleteRouteTable", "ec2:CreateRoute", "ec2:DeleteRoute", "ec2:AssociateRouteTable", "ec2:DisassociateRouteTable",
            "ec2:CreateSecurityGroup", "ec2:DeleteSecurityGroup", "ec2:AuthorizeSecurityGroupEgress", "ec2:AuthorizeSecurityGroupIngress",
            "ec2:RevokeSecurityGroupEgress", "ec2:RevokeSecurityGroupIngress", "ec2:ModifySecurityGroupRules", "ec2:UpdateSecurityGroupRuleDescriptionsEgress",
            "ec2:UpdateSecurityGroupRuleDescriptionsIngress", "ec2:CreateTags", "ec2:DeleteTags",
          ]
          Resource  = "*"
          Condition = local.in_reg
        },
        {
          Sid    = "ManageMachinesAndVolumes"
          Effect = "Allow"
          Action = [
            "ec2:CreateLaunchTemplate", "ec2:CreateLaunchTemplateVersion", "ec2:ModifyLaunchTemplate", "ec2:DeleteLaunchTemplate", "ec2:DeleteLaunchTemplateVersions",
            "ec2:RunInstances", "ec2:StartInstances", "ec2:StopInstances", "ec2:TerminateInstances", "ec2:ModifyInstanceAttribute", "ec2:MonitorInstances",
            "ec2:CancelSpotInstanceRequests", "ec2:CreateVolume", "ec2:DeleteVolume", "ec2:ModifyVolume", "ec2:AttachVolume", "ec2:DetachVolume",
            "ec2:CreateSnapshot", "ec2:DeleteSnapshot",
          ]
          Resource  = "*"
          Condition = local.in_reg
        },
        {
          Sid       = "ManageStackGroups"
          Effect    = "Allow"
          Action    = ["autoscaling:CreateAutoScalingGroup", "autoscaling:UpdateAutoScalingGroup", "autoscaling:DeleteAutoScalingGroup", "autoscaling:SetDesiredCapacity", "autoscaling:EnableMetricsCollection", "autoscaling:DisableMetricsCollection", "autoscaling:CreateOrUpdateTags", "autoscaling:DeleteTags"]
          Resource  = ["${local.arn}:autoscaling:${var.region}:${local.account_id}:autoScalingGroup:*:autoScalingGroupName/${local.p}-*"]
          Condition = local.in_reg
        },
        {
          Sid      = "ReadPublicImageParameters"
          Effect   = "Allow"
          Action   = ["ssm:GetParameter", "ssm:GetParameters"]
          Resource = ["${local.arn}:ssm:${var.region}::parameter/aws/service/*"]
        },
      ]
    }

    services = {
      Version = "2012-10-17"
      Statement = [
        {
          Sid      = "ManageStackParametersAndRunbooks"
          Effect   = "Allow"
          Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters", "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource", "ssm:ListTagsForResource", "ssm:CreateDocument", "ssm:UpdateDocument", "ssm:UpdateDocumentDefaultVersion", "ssm:DeleteDocument", "ssm:DescribeDocument", "ssm:DescribeDocumentPermission", "ssm:GetDocument"]
          Resource = ["${local.arn}:ssm:${var.region}:${local.account_id}:parameter/${local.p}/*", "${local.arn}:ssm:${var.region}:${local.account_id}:document/${local.p}-*"]
        },
        {
          Sid      = "ManageStackFunctionsQueuesAndTables"
          Effect   = "Allow"
          Action   = ["lambda:*Function*", "lambda:*Alias*", "lambda:AddPermission", "lambda:RemovePermission", "lambda:GetPolicy", "lambda:TagResource", "lambda:UntagResource", "lambda:ListTags", "lambda:ListVersionsByFunction", "lambda:PublishVersion", "sqs:CreateQueue", "sqs:DeleteQueue", "sqs:GetQueueAttributes", "sqs:SetQueueAttributes", "sqs:TagQueue", "sqs:UntagQueue", "sqs:ListQueueTags", "dynamodb:CreateTable", "dynamodb:DeleteTable", "dynamodb:DescribeTable", "dynamodb:UpdateTable", "dynamodb:DescribeTimeToLive", "dynamodb:UpdateTimeToLive", "dynamodb:DescribeContinuousBackups", "dynamodb:UpdateContinuousBackups", "dynamodb:TagResource", "dynamodb:UntagResource", "dynamodb:ListTagsOfResource"]
          Resource = ["${local.arn}:lambda:${var.region}:${local.account_id}:function:${local.p}-*", "${local.arn}:sqs:${var.region}:${local.account_id}:${local.p}-*", "${local.arn}:dynamodb:${var.region}:${local.account_id}:table/${local.p}-*"]
        },
        {
          Sid      = "ManageStackSchedulesRulesTopicsAndAlarms"
          Effect   = "Allow"
          Action   = ["scheduler:CreateSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule", "scheduler:TagResource", "scheduler:ListTagsForResource", "events:PutRule", "events:DeleteRule", "events:DescribeRule", "events:PutTargets", "events:RemoveTargets", "events:ListTargetsByRule", "events:TagResource", "events:UntagResource", "events:ListTagsForResource", "sns:CreateTopic", "sns:DeleteTopic", "sns:GetTopicAttributes", "sns:SetTopicAttributes", "sns:Subscribe", "sns:Unsubscribe", "sns:GetSubscriptionAttributes", "sns:ListSubscriptionsByTopic", "sns:TagResource", "sns:UntagResource", "sns:ListTagsForResource", "cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:TagResource", "cloudwatch:UntagResource", "cloudwatch:ListTagsForResource", "cloudwatch:PutDashboard", "cloudwatch:GetDashboard", "cloudwatch:DeleteDashboards"]
          Resource = ["${local.arn}:scheduler:${var.region}:${local.account_id}:schedule/*/${local.p}-*", "${local.arn}:events:${var.region}:${local.account_id}:rule/${local.p}-*", "${local.arn}:sns:${var.region}:${local.account_id}:${local.p}-*", "${local.arn}:cloudwatch:${var.region}:${local.account_id}:alarm:${local.p}-*", "${local.arn}:cloudwatch::${local.account_id}:dashboard/${local.p}-*"]
        },
        {
          Sid      = "ManageStackLogGroupsAndBudgets"
          Effect   = "Allow"
          Action   = ["logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:PutRetentionPolicy", "logs:DeleteRetentionPolicy", "logs:TagResource", "logs:UntagResource", "logs:ListTagsForResource", "logs:PutMetricFilter", "logs:DeleteMetricFilter", "budgets:ViewBudget", "budgets:ModifyBudget", "budgets:DeleteBudget", "budgets:TagResource", "budgets:UntagResource", "budgets:ListTagsForResource"]
          Resource = ["${local.arn}:logs:${var.region}:${local.account_id}:log-group:/${local.p}/*", "${local.arn}:logs:${var.region}:${local.account_id}:log-group:/aws/lambda/${local.p}-*", "${local.arn}:budgets::${local.account_id}:budget/${local.p}-*"]
        },
        # These take no resource, or create one whose name is not in the ARN the call is authorised against.
        {
          Sid      = "WildcardOnlyCalls"
          Effect   = "Allow"
          Action   = ["dlm:CreateLifecyclePolicy", "dlm:GetLifecyclePolicies", "dlm:GetLifecyclePolicy", "dlm:UpdateLifecyclePolicy", "dlm:DeleteLifecyclePolicy", "dlm:TagResource", "dlm:UntagResource", "dlm:ListTagsForResource", "rbin:CreateRule", "rbin:GetRule", "rbin:ListRules", "rbin:UpdateRule", "rbin:DeleteRule", "rbin:TagResource", "rbin:UntagResource", "rbin:ListTagsForResource", "logs:DescribeLogGroups", "cloudwatch:DescribeAlarms", "ssm:DescribeParameters", "ce:GetCostAndUsage", "ce:ListCostAllocationTags", "ce:UpdateCostAllocationTagsStatus", "sts:GetCallerIdentity"]
          Resource = "*"
        },
        {
          Sid      = "ReadWriteState"
          Effect   = "Allow"
          Action   = ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
          Resource = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
        },
      ]
    }
  }
}

resource "aws_iam_policy" "deploy" {
  for_each    = local.deploy_policies
  name        = "${var.name_prefix}-deploy-${each.key}"
  description = "Deploy principal for ${var.name_prefix} stacks: ${each.key}."
  policy      = jsonencode(each.value)
}

resource "aws_iam_role_policy_attachment" "deploy" {
  for_each   = var.deploy_role_name == null ? {} : aws_iam_policy.deploy
  role       = var.deploy_role_name
  policy_arn = each.value.arn
}
