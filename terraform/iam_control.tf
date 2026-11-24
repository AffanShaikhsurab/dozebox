# The control function's role. Its managed policies (part 8 §8.2) are attached in this file by WP-T2.
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
  tags = local.tags
}
