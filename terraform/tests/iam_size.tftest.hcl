mock_provider "aws" {
  # Real-shaped values: the mock's random strings would make ARNs short (and the provider rejects some of them).
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "111122223333" }
  }
  override_data {
    target = data.aws_region.current
    values = { region = "ap-southeast-2" }
  }
  override_data {
    target = data.aws_partition.current
    values = { partition = "aws" }
  }
  override_data {
    target = data.aws_ec2_instance_type_offerings.home
    values = { locations = ["ap-southeast-2b", "ap-southeast-2a", "ap-southeast-2a", "ap-southeast-2c"] }
  }
  override_data {
    target = data.aws_ssm_parameter.ami
    values = { insecure_value = "ami-0123456789abcdef0", value = "ami-0123456789abcdef0" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111122223333:role/dozebox-a2345678901234567890-scheduler" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::111122223333:policy/dozebox-a2345678901234567890-control-volumes" }
  }
  mock_resource "aws_iam_instance_profile" {
    defaults = { arn = "arn:aws:iam::111122223333:instance-profile/dozebox-a2345678901234567890-box" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:ap-southeast-2:111122223333:dozebox-a2345678901234567890-alerts" }
  }
  mock_resource "aws_launch_template" {
    defaults = { id = "lt-0123456789abcdef0", arn = "arn:aws:ec2:ap-southeast-2:111122223333:launch-template/lt-0123456789abcdef0" }
  }
  mock_resource "aws_security_group" {
    defaults = { id = "sg-0123456789abcdef0", arn = "arn:aws:ec2:ap-southeast-2:111122223333:security-group/sg-0123456789abcdef0" }
  }
  mock_resource "aws_subnet" {
    defaults = { id = "subnet-0123456789abcdef0" }
  }
  mock_resource "aws_vpc" {
    defaults = { id = "vpc-0123456789abcdef0" }
  }
  mock_resource "aws_instance" {
    defaults = { id = "i-0123456789abcdef0" }
  }
  mock_resource "aws_ebs_volume" {
    defaults = { id = "vol-0123456789abcdef0" }
  }
}

variables {
  box_id      = "a2345678901234567890" # 20 characters: the worst case for names and ARNs
  instance    = { types = ["t4g.small", "t4g.medium"] }
  data_volume = { size_gb = 20 }
  caps        = { monthly_budget_usd = 25 }
  payloads = {
    demo = { schema = 1, name = "demo", user = "demo", protocol = "none", start = { command = ["/bin/true"] } }
  }
  agent = { version = "none" }
}
# Every managed policy fits under 5,500 characters (IAM limit 6,144) with real-shaped ARNs and a 20-character box id;
# every role has at most 8 managed policies (default quota 20). Part 10 §10.2.
run "every_managed_policy_fits_in_the_worst_case" {
  command = apply
  variables {
    enable_ssm_session = true
    alerts             = { email = "ops@example.com", ntfy_secret = "ntfy-topic-url-for-phone-alerts-00000000", webhook_secret = "webhook-signing-secret-00000000000000000", healthchecks_secret = "healthchecks-ping-url-000000000000000000" }
    wake_sources = {
      github  = { enabled = true, secret = "github-webhook-secret-000000000000000000" }
      generic = { enabled = true, secret = "generic-webhook-secret-00000000000000000" }
    }
    payloads = {
      demo = { schema = 1, name = "demo", user = "demo", protocol = "none", start = { command = ["/bin/true"] },
        secrets = [for i in range(8) : { name = format("payload-secret-%02d-0000000000000000000000", i), as = { env = format("SECRET_%02d", i) } }]
      }
    }
  }

  assert {
    condition = alltrue([for name, p in local.all_policies : length(jsonencode(jsondecode(p.policy))) <= 5500])
    error_message = "A managed policy is over 5,500 characters (IAM limit 6,144): ${join(", ", [
      for name, p in local.all_policies : "${name}=${length(jsonencode(jsondecode(p.policy)))}"
    if length(jsonencode(jsondecode(p.policy))) > 5500])}. Split by concern; never wildcard to save room."
  }
  assert {
    condition     = alltrue([for role, list in local.role_policies : length(list) <= 8])
    error_message = "A role has more than 8 managed policies (default quota 20)."
  }
  assert {
    condition     = length(local.all_policies) == 15 && length(output.iam_policy_sizes) == 15
    error_message = "With ssm session on, the module has 15 managed policies and iam_policy_sizes reports each."
  }
  assert {
    condition     = length(aws_iam_role_policy_attachment.managed) == sum([for role, list in local.role_policies : length(list)])
    error_message = "Every policy in role_policies is attached, and nothing else."
  }
  assert {
    condition     = alltrue([for k in keys(local.all_policies) : contains(keys(local.policy_documents), k)])
    error_message = "Every policy in all_policies has its document in policy_documents."
  }
}

run "session_manager_policy_only_when_asked" {
  command = plan

  assert {
    condition     = length(aws_iam_policy.box_ssm_session) == 0 && !contains(local.role_policy_keys.box, "box_ssm_session")
    error_message = "The Session Manager policy exists only with enable_ssm_session."
  }
}

# Accounts whose deploy principal may only create bounded roles set iam_permissions_boundary; every role gets it.
# scripts/test/terraform-iam.test.ts checks that each aws_iam_role block in terraform/*.tf passes the input.
run "every_role_carries_the_permissions_boundary" {
  command = plan
  variables {
    iam_permissions_boundary = "arn:aws:iam::111122223333:policy/test-boundary"
  }

  assert {
    condition     = alltrue([for r in local.roles : r.permissions_boundary == "arn:aws:iam::111122223333:policy/test-boundary"])
    error_message = "Every role must carry iam_permissions_boundary."
  }
}

run "no_permissions_boundary_by_default" {
  command = plan

  assert {
    condition     = alltrue([for r in local.roles : r.permissions_boundary == null])
    error_message = "Without iam_permissions_boundary, no role has a boundary."
  }
}

run "rejects_a_permissions_boundary_that_is_not_a_policy_arn" {
  command = plan
  variables {
    iam_permissions_boundary = "dozebox-test-boundary"
  }
  expect_failures = [var.iam_permissions_boundary]
}
