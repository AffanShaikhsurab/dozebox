# The role EventBridge assumes to start the kill runbook when a kill switch alarm fires (caps.tf). An EventBridge
# target that starts SSM Automation needs a role of its own; the kill role itself is assumed by SSM Automation only.
# It can start that one runbook, and pass that one role to it.
resource "aws_iam_role" "kill_events" {
  name                 = "${local.name}-kill-events"
  permissions_boundary = var.iam_permissions_boundary
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "EventsOnly"
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
  tags = local.tags
}

locals {
  kill_definition_arn = "arn:${local.partition}:ssm:${local.region}:${local.account_id}:automation-definition/${local.kill_document}"

  kill_events_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "StartOnlyTheKillRunbook"
        Effect   = "Allow"
        Action   = ["ssm:StartAutomationExecution"]
        Resource = [local.kill_definition_arn, "${local.kill_definition_arn}:*"]
      },
      {
        Sid       = "PassOnlyTheKillRole"
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = [aws_iam_role.kill.arn]
        Condition = { StringEquals = { "iam:PassedToService" = "ssm.amazonaws.com" } }
      },
    ]
  }
}

resource "aws_iam_policy" "kill_events" {
  name        = "${local.name}-kill-events"
  description = "Kill switch rule ${var.box_id}: start the kill runbook with the kill role."
  policy      = jsonencode(local.kill_events_policy)
  tags        = local.tags
}
