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
