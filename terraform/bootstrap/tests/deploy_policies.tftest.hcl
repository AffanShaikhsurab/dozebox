mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "111122223333" }
  }
  override_data {
    target = data.aws_partition.current
    values = { partition = "aws" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::111122223333:policy/abcdefghijklmnop-deploy-services" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::dozebox-tfstate-111122223333-ap-southeast-2", id = "dozebox-tfstate-111122223333-ap-southeast-2" }
  }
}

variables {
  region      = "ap-southeast-2"   # the longest region name: the worst case for ARN lengths
  name_prefix = "abcdefghijklmnop" # 16 characters, the longest prefix the module accepts
}

run "every_deploy_policy_fits_under_the_iam_limit" {
  command = apply

  assert {
    condition = alltrue([for k, p in aws_iam_policy.deploy : length(jsonencode(jsondecode(p.policy))) <= 6144])
    error_message = "A deploy policy is over 6,144 characters: ${join(", ", [
      for k, p in aws_iam_policy.deploy : "${k}=${length(jsonencode(jsondecode(p.policy)))}"
    if length(jsonencode(jsondecode(p.policy))) > 6144])}."
  }
  assert {
    condition     = length(output.deploy_policy_sizes) == 3 && length(aws_iam_role_policy_attachment.deploy) == 0
    error_message = "Three deploy policies, attached to nothing unless deploy_role_name is set."
  }
}

run "deploy_policies_never_grant_everything" {
  command = plan

  assert {
    condition = alltrue(flatten([for k, doc in local.deploy_policies : [
      for s in doc.Statement : [for a in flatten([s.Action]) : a != "*" && !can(regex(":\\*$", a))] if s.Effect == "Allow"
    ]]))
    error_message = "No Allow statement grants * or a whole service (service:*)."
  }
  assert {
    condition = alltrue(flatten([for k, doc in local.deploy_policies : [
      for s in doc.Statement : !contains(flatten([s.Action]), "iam:PutRolePolicy") if s.Effect == "Allow"
    ]]))
    error_message = "The deploy principal never puts an inline role policy (the I-13 lesson)."
  }
  assert {
    condition     = contains(one([for s in local.deploy_policies.iam.Statement : s if s.Sid == "NeverInlinePolicies"]).Action, "iam:PutRolePolicy")
    error_message = "An explicit Deny stops inline policies even if another policy allows them."
  }
  assert {
    condition = alltrue([for s in local.deploy_policies.iam.Statement : alltrue([
      for r in flatten([s.Resource]) : r == "*" || can(regex("^arn:aws:iam::111122223333:(role|policy|instance-profile)/(abcdefghijklmnop-\\*|aws-service-role/\\*)$", r))
    ]) if s.Effect == "Allow"])
    error_message = "IAM actions reach only <prefix>-* roles, policies and instance profiles (and service-linked roles)."
  }
  assert {
    condition     = one([for s in local.deploy_policies.iam.Statement : s if s.Sid == "AttachOnlyStackPolicies"]).Condition.ArnLike["iam:PolicyARN"] == "arn:aws:iam::111122223333:policy/abcdefghijklmnop-*"
    error_message = "The deploy principal attaches only the stack's own managed policies."
  }
}

run "state_bucket_is_private_versioned_and_tls_only" {
  command = plan

  assert {
    condition     = aws_s3_bucket.state.bucket == "abcdefghijklmnop-tfstate-111122223333-ap-southeast-2"
    error_message = "The bucket is named <prefix>-tfstate-<account>-<region>."
  }
  assert {
    condition     = aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "State is versioned."
  }
  assert {
    condition = (aws_s3_bucket_public_access_block.state.block_public_acls && aws_s3_bucket_public_access_block.state.block_public_policy
    && aws_s3_bucket_public_access_block.state.ignore_public_acls && aws_s3_bucket_public_access_block.state.restrict_public_buckets)
    error_message = "Every public access block flag is on."
  }
  assert {
    condition     = local.state_bucket_policy.Statement[0].Effect == "Deny" && local.state_bucket_policy.Statement[0].Condition.Bool["aws:SecureTransport"] == "false"
    error_message = "The bucket refuses requests without TLS."
  }
}

run "attaches_to_the_deploy_role_when_named" {
  command = plan
  variables {
    deploy_role_name = "abcdefghijklmnop-deployer"
  }

  assert {
    condition     = length(aws_iam_role_policy_attachment.deploy) == 3
    error_message = "With deploy_role_name, all three policies are attached to it."
  }
}

run "rejects_a_bad_name_prefix" {
  command = plan
  variables {
    name_prefix = "Not Valid"
  }
  expect_failures = [var.name_prefix]
}
