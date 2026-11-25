# The machine: one launch template per shutdown behaviour, the persistent Spot instance (machine_mode "persistent")
# or the Spot group (machine_mode "group"), and the user data. The On-Demand fallback group is in fallback.tf.
locals {
  stage0_template = "${path.module}/../box/cloud-init.yaml.tftpl"

  # agent.version "none" is for test stacks before stage 0 exists: log to the console and power off, so the instance
  # stops (shutdown behaviour "stop") and the stack is parked with nothing on it.
  user_data_none = <<-EOT
    #!/bin/sh
    echo "${local.name}: agent.version is none, powering off" > /dev/console
    poweroff
  EOT

  user_data = var.agent.version == "none" || !fileexists(local.stage0_template) ? local.user_data_none : templatefile(local.stage0_template, {
    box_id           = var.box_id
    name_prefix      = var.name_prefix
    region           = local.region
    config_parameter = aws_ssm_parameter.config.name
    agent_version    = var.agent.version
    agent_base_url   = var.agent.artifact_base_url
    agent_sha256     = try(var.agent.sha256[var.instance.arch], "")
  })

  # EC2 accepts 16,384 bytes of user data; the module keeps a margin (part 9 §9.2.7). base64 is 4/3 of the gzip bytes.
  user_data_gzip_bytes = floor(length(base64gzip(local.user_data)) * 3 / 4)

  role_tag = "${local.tag_prefix}:role"

  # A maximum price raises the interruption rate (notes/06a), so it is sent only when the operator sets one.
  spot_max_price = var.caps.max_spot_price_per_hour == null ? null : tostring(var.caps.max_spot_price_per_hour)
}

data "aws_ssm_parameter" "ami" {
  name = local.ami_ssm_parameter
}

resource "aws_launch_template" "box" {
  for_each = {
    # The persistent instance stops on a guest shutdown: terminating a persistent Spot instance would reopen its
    # request. Group instances terminate, so the group can replace them.
    persistent = "stop"
    group      = "terminate"
  }

  name                                 = "${local.names.launch_template}-${each.key}"
  description                          = "Dozebox box ${var.box_id} (${each.key}). The instance or group picks the type."
  image_id                             = data.aws_ssm_parameter.ami.insecure_value
  update_default_version               = true
  instance_initiated_shutdown_behavior = each.value
  vpc_security_group_ids               = [aws_security_group.box.id]
  user_data                            = base64gzip(local.user_data)

  iam_instance_profile {
    arn = aws_iam_instance_profile.box.arn
  }

  # 1-minute metrics feed the awake and egress alarms.
  monitoring {
    enabled = true
  }

  # IMDSv2 only, hop limit 1: a container on the box cannot reach the instance credentials.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  # The root disk is disposable; all state is on the data volume.
  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_size           = var.instance.root_volume_gb
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  # Everything a launch creates is tagged in the launch request itself, so an account that only allows creating tagged
  # EC2 resources accepts it. The persistent instance's Spot request is tagged too; groups make no such request.
  dynamic "tag_specifications" {
    for_each = merge(
      { instance = local.name, volume = "${local.name}-root", network-interface = "${local.name}-eni" },
      each.key == "persistent" ? { spot-instances-request = local.name } : {},
    )
    content {
      resource_type = tag_specifications.key
      tags          = merge(local.tags, { Name = tag_specifications.value })
    }
  }

  tags = merge(local.tags, { Name = "${local.names.launch_template}-${each.key}" })

  lifecycle {
    precondition {
      condition     = var.agent.version == "none" || fileexists(local.stage0_template)
      error_message = "agent.version other than none needs box/cloud-init.yaml.tftpl (stage 0, WP-A4)."
    }
    precondition {
      condition     = local.user_data_gzip_bytes <= 12800
      error_message = "User data is ${local.user_data_gzip_bytes} bytes gzipped; the budget is 12,800 (EC2 limit 16,384)."
    }
  }
}

# One Spot instance that the control function stops when idle and starts on wake (about 20 s instead of a fresh
# launch). A reclaim stops it, the request stays open, and EC2 starts it again when capacity returns.
resource "aws_instance" "persistent" {
  count = var.instance.machine_mode == "persistent" ? 1 : 0

  instance_type = var.instance.types[0]
  subnet_id     = local.subnet_id

  launch_template {
    id      = aws_launch_template.box["persistent"].id
    version = "$Latest"
  }

  instance_market_options {
    market_type = "spot"
    spot_options {
      spot_instance_type             = "persistent"
      instance_interruption_behavior = "stop"
      max_price                      = local.spot_max_price
    }
  }

  tags = merge(local.tags, { Name = local.name, (local.role_tag) = "persistent" })

  # An apply never stops, resizes or replaces the running box: new user data and images reach it through the CLI's
  # rebuild. EC2 refuses to modify the shutdown behaviour of a Spot instance, so drift there is ignored too.
  lifecycle {
    ignore_changes = [launch_template[0].version, instance_type, user_data, ami]
  }
}

resource "aws_ec2_instance_state" "persistent" {
  count       = var.instance.machine_mode == "persistent" ? 1 : 0
  instance_id = aws_instance.persistent[0].id
  state       = "stopped"
  lifecycle {
    ignore_changes = [state] # the control function owns the state after the first apply
  }
}

# machine_mode "group": the box is whatever the Spot group launches; it parks by setting the group to 0.
# max_size 1 and no capacity rebalance keep one writer per volume at the placement layer.
resource "aws_autoscaling_group" "spot" {
  count = var.instance.machine_mode == "group" ? 1 : 0

  name                      = local.names.group
  min_size                  = 0
  max_size                  = 1
  desired_capacity          = 0
  vpc_zone_identifier       = [local.subnet_id]
  capacity_rebalance        = false
  health_check_type         = "EC2"
  health_check_grace_period = 300
  enabled_metrics           = ["GroupInServiceInstances"]

  mixed_instances_policy {
    instances_distribution {
      on_demand_base_capacity                  = 0
      on_demand_percentage_above_base_capacity = 0
      spot_allocation_strategy                 = "price-capacity-optimized"
      spot_max_price                           = var.caps.max_spot_price_per_hour == null ? "" : tostring(var.caps.max_spot_price_per_hour)
    }
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.box["group"].id
        version            = "$Latest"
      }
      dynamic "override" {
        for_each = var.instance.types
        content {
          instance_type = override.value
        }
      }
    }
  }

  dynamic "tag" {
    for_each = merge(local.tags, { Name = local.name, (local.role_tag) = "group" })
    content {
      key                 = tag.key
      value               = tag.value
      propagate_at_launch = true
    }
  }

  lifecycle {
    ignore_changes = [desired_capacity]
  }
}
