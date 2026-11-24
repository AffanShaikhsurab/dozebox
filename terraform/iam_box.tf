# The instance role of the box. Its managed policies (one per concern, part 8 §8.2) are attached in this file by WP-T2.
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
  tags = local.tags
}

resource "aws_iam_instance_profile" "box" {
  name = local.names.box_role
  role = aws_iam_role.box.name
  tags = local.tags
}
