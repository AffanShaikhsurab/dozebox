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
# Persistent Spot with stop, the fallback group at 0, IMDSv2 with hop limit 1, user data under budget (part 10 §10.2).
run "persistent_spot_instance_stops_on_interruption" {
  command = apply
  variables {
    caps = { monthly_budget_usd = 25, max_spot_price_per_hour = 0.03 }
  }

  assert {
    condition = (
      aws_instance.persistent[0].instance_market_options[0].market_type == "spot" &&
      aws_instance.persistent[0].instance_market_options[0].spot_options[0].spot_instance_type == "persistent" &&
      aws_instance.persistent[0].instance_market_options[0].spot_options[0].instance_interruption_behavior == "stop"
    )
    error_message = "The persistent instance is a persistent Spot request that stops on interruption."
  }
  assert {
    condition     = aws_instance.persistent[0].instance_market_options[0].spot_options[0].max_price == "0.03"
    error_message = "caps.max_spot_price_per_hour becomes the Spot max price."
  }
  assert {
    condition     = aws_instance.persistent[0].instance_type == "t4g.small" && aws_instance.persistent[0].tags["dozebox:role"] == "persistent"
    error_message = "The persistent instance uses the first type and is tagged <prefix>:role = persistent."
  }
  assert {
    condition     = aws_ec2_instance_state.persistent[0].state == "stopped"
    error_message = "A fresh stack starts parked."
  }
  assert {
    condition     = aws_launch_template.box["persistent"].instance_initiated_shutdown_behavior == "stop" && aws_launch_template.box["group"].instance_initiated_shutdown_behavior == "terminate"
    error_message = "A guest shutdown stops the persistent instance and terminates a group instance."
  }
  assert {
    condition = alltrue([for lt in aws_launch_template.box :
      lt.metadata_options[0].http_tokens == "required" && lt.metadata_options[0].http_put_response_hop_limit == 1
    ])
    error_message = "IMDSv2 is required with a hop limit of 1 on every launch template."
  }
  assert {
    condition     = alltrue([for lt in aws_launch_template.box : lt.block_device_mappings[0].ebs[0].encrypted == "true"])
    error_message = "Root disks are encrypted."
  }
  assert {
    condition     = length(aws_autoscaling_group.spot) == 0
    error_message = "machine_mode persistent has no Spot group."
  }
  assert {
    condition     = local.home_az == "ap-southeast-2a" && aws_subnet.box[0].availability_zone == "ap-southeast-2a"
    error_message = "The home AZ is the first AZ that offers every instance type."
  }
}

run "no_max_price_unless_set" {
  command = plan

  assert {
    condition     = local.spot_max_price == null
    error_message = "Without caps.max_spot_price_per_hour no max price is sent (a cap raises the interruption rate)."
  }
}

run "fallback_group_starts_at_zero" {
  command = plan
  variables {
    fallback = { types = ["t4g.medium"] }
  }

  assert {
    condition = (
      aws_autoscaling_group.fallback[0].desired_capacity == 0 && aws_autoscaling_group.fallback[0].min_size == 0 &&
      aws_autoscaling_group.fallback[0].max_size == 1 && !aws_autoscaling_group.fallback[0].capacity_rebalance
    )
    error_message = "The fallback group is min 0, max 1, desired 0, no capacity rebalance."
  }
  assert {
    condition     = aws_autoscaling_group.fallback[0].mixed_instances_policy[0].instances_distribution[0].on_demand_percentage_above_base_capacity == 100
    error_message = "The fallback group is On-Demand only."
  }
  assert {
    condition = length(setsubtract(
      [for o in aws_autoscaling_group.fallback[0].mixed_instances_policy[0].launch_template[0].override : o.instance_type],
      var.instance.types,
    )) == 0
    error_message = "Fallback types are a subset of the instance types."
  }
  assert {
    condition     = [for o in aws_autoscaling_group.fallback[0].mixed_instances_policy[0].launch_template[0].override : o.instance_type] == ["t4g.medium"]
    error_message = "fallback.types picks the fallback's types."
  }
  assert {
    condition     = one([for t in aws_autoscaling_group.fallback[0].tag : t if t.key == "dozebox:role"]).value == "fallback"
    error_message = "Fallback instances are tagged <prefix>:role = fallback."
  }
}

run "fallback_can_be_off" {
  command = plan
  variables {
    fallback = { enabled = false }
  }

  assert {
    condition     = length(aws_autoscaling_group.fallback) == 0
    error_message = "fallback.enabled = false removes the group."
  }
}

run "group_mode_has_a_spot_group_and_no_instance" {
  command = plan
  variables {
    instance = { types = ["t4g.small", "t4g.medium"], machine_mode = "group" }
  }

  assert {
    condition     = length(aws_instance.persistent) == 0 && length(aws_ec2_instance_state.persistent) == 0
    error_message = "machine_mode group has no persistent instance."
  }
  assert {
    condition = (
      aws_autoscaling_group.spot[0].desired_capacity == 0 && aws_autoscaling_group.spot[0].max_size == 1 &&
      aws_autoscaling_group.spot[0].mixed_instances_policy[0].instances_distribution[0].on_demand_percentage_above_base_capacity == 0
    )
    error_message = "The Spot group is Spot only, max 1, desired 0."
  }
}

run "agent_none_user_data_powers_off_within_budget" {
  command = plan

  assert {
    condition     = strcontains(local.user_data, "poweroff") && local.user_data_gzip_bytes <= 12800
    error_message = "agent.version none renders user data that powers off, within 12,800 gzipped bytes."
  }
}

run "an_agent_version_needs_stage0" {
  command = plan
  variables {
    agent = { version = "1.0.0" }
  }
  expect_failures = [aws_launch_template.box]
}

run "existing_network_uses_its_subnet" {
  command = plan
  variables {
    network = { create = false, vpc_id = "vpc-0aaaaaaaaaaaaaaaa", subnet_ids = ["subnet-0bbbbbbbbbbbbbbbb"] }
  }
  override_data {
    target = data.aws_subnet.existing[0]
    values = { availability_zone = "ap-southeast-2c" }
  }

  assert {
    condition     = length(aws_vpc.box) == 0 && local.home_az == "ap-southeast-2c" && aws_security_group.box.vpc_id == "vpc-0aaaaaaaaaaaaaaaa"
    error_message = "An existing network is used as given; the home AZ is its subnet's."
  }
  assert {
    condition     = aws_instance.persistent[0].subnet_id == "subnet-0bbbbbbbbbbbbbbbb"
    error_message = "The instance goes in the given subnet."
  }
}

run "no_inbound_rule_unless_ssh_cidrs" {
  command = plan

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.ssh) == 0
    error_message = "The security group has no inbound rule by default."
  }
}

# An account that only allows creating tagged EC2 resources (the test account) accepts every launch: the instance,
# its volumes, its ENI and the persistent Spot request carry the operator's tags in the launch request.
run "launches_are_tagged_on_create" {
  command = plan
  variables {
    tags     = { "dozebox:test" = "unit" }
    fallback = { enabled = true }
  }

  assert {
    condition = (
      sort([for t in aws_launch_template.box["persistent"].tag_specifications : t.resource_type]) == tolist(["instance", "network-interface", "spot-instances-request", "volume"])
      && sort([for t in aws_launch_template.box["group"].tag_specifications : t.resource_type]) == tolist(["instance", "network-interface", "volume"])
    )
    error_message = "The persistent template tags instance, volume, ENI and Spot request; the group template the first three."
  }
  assert {
    condition = alltrue(flatten([for lt in aws_launch_template.box : [
      for t in lt.tag_specifications : t.tags["dozebox:test"] == "unit" && t.tags["dozebox:box"] == "a2345678901234567890"
    ]]))
    error_message = "Every tag specification carries the module tags and the box tag."
  }
  assert {
    condition     = aws_instance.persistent[0].tags["dozebox:test"] == "unit"
    error_message = "The persistent instance carries the module tags."
  }
  assert {
    condition     = one([for t in aws_autoscaling_group.fallback[0].tag : t if t.key == "dozebox:test"]).propagate_at_launch
    error_message = "The fallback group propagates the module tags to what it launches."
  }
  assert {
    # local.data_volume_tags: an earlier run of this file created the volume, and the volume ignores tag changes.
    condition     = local.data_volume_tags["dozebox:test"] == "unit" && local.data_volume_tags["dozebox:active"] == "true"
    error_message = "The data volume carries the module tags and active = true."
  }
}
