# Applied once per account by an administrator, before the first stack: the Terraform state bucket and the deploy
# principal's managed policies (deploy_policies.tf). Nothing in the module reads this stack.
provider "aws" {
  region = var.region
  default_tags {
    tags = merge({ "${var.name_prefix}:component" = "bootstrap" }, var.tags)
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id        = data.aws_caller_identity.current.account_id
  partition         = data.aws_partition.current.partition
  state_bucket_name = coalesce(var.state_bucket_name, "${var.name_prefix}-tfstate-${local.account_id}-${var.region}")
}

resource "aws_s3_bucket" "state" {
  bucket = local.state_bucket_name
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

locals {
  state_bucket_policy = {
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TlsOnly"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket     = aws_s3_bucket.state.id
  policy     = jsonencode(local.state_bucket_policy)
  depends_on = [aws_s3_bucket_public_access_block.state]
}

output "state_bucket_name" {
  description = "Put in the stack's backend configuration."
  value       = aws_s3_bucket.state.bucket
}

output "backend_hcl" {
  description = "A backend.hcl for a stack: terraform init -backend-config=backend.hcl."
  value       = <<-EOT
    bucket       = "${aws_s3_bucket.state.bucket}"
    key          = "${var.name_prefix}/terraform.tfstate"
    region       = "${var.region}"
    encrypt      = true
    use_lockfile = true
  EOT
}

output "deploy_policy_arns" {
  description = "Attach these to the deploy principal (done here when deploy_role_name is set)."
  value       = { for k, p in aws_iam_policy.deploy : k => p.arn }
}

output "deploy_policy_sizes" {
  description = "Characters of each deploy policy as IAM counts them (limit 6,144)."
  value       = { for k, p in aws_iam_policy.deploy : k => length(jsonencode(jsondecode(p.policy))) }
}
