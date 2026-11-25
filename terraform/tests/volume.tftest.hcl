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
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:ap-southeast-2:111122223333:rule/dozebox-main-mock" }
  }
  mock_resource "aws_cloudwatch_metric_alarm" {
    defaults = { arn = "arn:aws:cloudwatch:ap-southeast-2:111122223333:alarm:dozebox-main-mock" }
  }
  override_resource {
    target = aws_lambda_function.control
    values = { arn = "arn:aws:lambda:ap-southeast-2:111122223333:function:dozebox-main-control", version = "3" }
  }
  override_resource {
    target = aws_lambda_alias.live
    values = { arn = "arn:aws:lambda:ap-southeast-2:111122223333:function:dozebox-main-control:live" }
  }
  override_resource {
    target = aws_lambda_function_url.control
    values = { function_url = "https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.ap-southeast-2.on.aws/" }
  }
  override_resource {
    target = aws_sqs_queue.control_dlq
    values = { arn = "arn:aws:sqs:ap-southeast-2:111122223333:dozebox-main-control-dlq" }
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
# The data volume, its DLM snapshots and the Recycle Bin rule (part 10 §10.2). prevent_destroy on the guarded volume is
# checked statically by scripts/test/terraform-iam.test.ts, because terraform test cannot read lifecycle settings.
run "data_volume_is_encrypted_active_and_in_the_home_az" {
  command = plan
  variables {
    data_volume = { size_gb = 40, iops = 4000, throughput = 250 }
  }

  assert {
    condition = (
      aws_ebs_volume.data[0].encrypted && aws_ebs_volume.data[0].type == "gp3" && aws_ebs_volume.data[0].size == 40 &&
      aws_ebs_volume.data[0].iops == 4000 && aws_ebs_volume.data[0].throughput == 250
    )
    error_message = "The data volume is encrypted gp3 with the given size, iops and throughput."
  }
  assert {
    condition     = aws_ebs_volume.data[0].availability_zone == local.home_az
    error_message = "The data volume is in the home AZ."
  }
  assert {
    condition     = aws_ebs_volume.data[0].tags["dozebox:active"] == "true" && aws_ebs_volume.data[0].tags["Name"] == "dozebox-a2345678901234567890-data"
    error_message = "The data volume is tagged active and named for DLM."
  }
  assert {
    condition     = length(aws_ebs_volume.data_unguarded) == 0
    error_message = "Without drill_mode the guarded volume is the data volume."
  }
}

run "drill_mode_uses_the_unguarded_volume" {
  command = apply
  variables {
    drill_mode = true
  }

  assert {
    condition     = length(aws_ebs_volume.data) == 0 && length(aws_ebs_volume.data_unguarded) == 1
    error_message = "drill_mode swaps in the unguarded volume."
  }
  assert {
    condition     = aws_ebs_volume.data_unguarded[0].tags["dozebox:active"] == "true" && aws_ebs_volume.data_unguarded[0].encrypted
    error_message = "The drill volume is the same volume otherwise."
  }
  assert {
    condition     = output.data_volume_id == aws_ebs_volume.data_unguarded[0].id
    error_message = "data_volume_id is the volume in use."
  }
}

run "dlm_snapshots_follow_the_inputs" {
  command = plan
  variables {
    snapshots = { every_hours = 6, keep = 4, recycle_bin_days = 3 }
  }

  assert {
    condition = (
      aws_dlm_lifecycle_policy.snapshots.state == "ENABLED" &&
      aws_dlm_lifecycle_policy.snapshots.policy_details[0].schedule[0].create_rule[0].interval == 6 &&
      aws_dlm_lifecycle_policy.snapshots.policy_details[0].schedule[0].create_rule[0].interval_unit == "HOURS" &&
      aws_dlm_lifecycle_policy.snapshots.policy_details[0].schedule[0].retain_rule[0].count == 4
    )
    error_message = "DLM snapshots every snapshots.every_hours and keeps snapshots.keep."
  }
  assert {
    condition     = aws_dlm_lifecycle_policy.snapshots.policy_details[0].target_tags == tomap({ Name = "dozebox-a2345678901234567890-data" })
    error_message = "DLM targets the data volume by Name only (it matches any target tag)."
  }
  assert {
    condition     = strcontains(aws_dlm_lifecycle_policy.snapshots.description, "a2345678901234567890")
    error_message = "The DLM description names the box (the phase 1 exit finds the policy by it)."
  }
  assert {
    condition = (
      aws_rbin_rule.snapshots.resource_type == "EBS_SNAPSHOT" &&
      one(aws_rbin_rule.snapshots.retention_period).retention_period_value == 3 &&
      one(aws_rbin_rule.snapshots.resource_tags).resource_tag_key == "dozebox:box" &&
      one(aws_rbin_rule.snapshots.resource_tags).resource_tag_value == "a2345678901234567890"
    )
    error_message = "The Recycle Bin keeps this box's deleted snapshots for snapshots.recycle_bin_days."
  }
}