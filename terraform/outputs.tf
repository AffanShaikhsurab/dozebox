output "box_id" {
  description = "The box id."
  value       = var.box_id
}

output "region" {
  description = "The region the stack is in."
  value       = local.region
}

output "control_url" {
  description = "Base URL of the control API: the Function URL (AWS_IAM with front_door_enabled, else public). CloudFront is not built yet."
  value       = trimsuffix(aws_lambda_function_url.control.function_url, "/")
}

output "control_function_name" {
  description = "For aws lambda invoke admin calls."
  value       = local.names.control_function
}

output "ssm_prefix" {
  description = "/<prefix>/<box_id>/."
  value       = local.ssm_prefix
}

output "wake_token_parameter" {
  description = "Name of the SecureString holding the wake token (not the value)."
  value       = "${local.ssm_prefix}wake-token"
}

output "alert_topic_arn" {
  description = "SNS topic."
  value       = aws_sns_topic.alerts.arn
}

output "instance_role_arn" {
  description = "Role of the box."
  value       = aws_iam_role.box.arn
}

output "state_table_name" {
  description = "DynamoDB table (lease, outbox, ledgers)."
  value       = local.names.state_table
}

output "dashboard_url" {
  description = "CloudWatch dashboard."
  value       = "https://${local.region}.console.aws.amazon.com/cloudwatch/home?region=${local.region}#dashboards/dashboard/${local.names.dashboard}"
}
