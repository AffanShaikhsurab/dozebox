# The alert topic every sender publishes to (box, control function, budgets, alarms). Senders and their topic policy
# statements belong to the files that add them; this file owns the topic and the email subscription.
resource "aws_sns_topic" "alerts" {
  name = local.names.alert_topic
  tags = local.tags
}

resource "aws_sns_topic_subscription" "email" {
  count = var.alerts.email == null ? 0 : 1

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alerts.email
}

# The topic's only policy: the account's own principals (by their IAM policies), plus each service sender. A file
# that adds a service sender adds its statement here. A service principal is not covered by the account root
# statement, so CloudWatch alarms need their own (without it every alarm action fails with "not authorized: SNS:Publish").
resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountOwnsTheTopic"
        Effect    = "Allow"
        Principal = { AWS = "arn:${local.partition}:iam::${local.account_id}:root" }
        Action    = ["sns:Publish", "sns:Subscribe", "sns:GetTopicAttributes", "sns:SetTopicAttributes", "sns:ListSubscriptionsByTopic"]
        Resource  = aws_sns_topic.alerts.arn
      },
      {
        Sid       = "OnlyThisBoxBudgetPublishes"
        Effect    = "Allow"
        Principal = { Service = "budgets.amazonaws.com" }
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.alerts.arn
        Condition = {
          StringEquals = { "aws:SourceAccount" = local.account_id }
          ArnLike      = { "aws:SourceArn" = local.arns.budget }
        }
      },
      {
        Sid       = "OnlyThisBoxAlarmsPublish"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.alerts.arn
        Condition = {
          StringEquals = { "aws:SourceAccount" = local.account_id }
          ArnLike      = { "aws:SourceArn" = "arn:${local.partition}:cloudwatch:${local.region}:${local.account_id}:alarm:${local.name}-*" }
        }
      },
    ]
  })
}
