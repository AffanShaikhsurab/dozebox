# The On-Demand fallback: its own group, min 0 and max 1, desired 0 until the control function launches into it when
# no Spot capacity is left (and caps.on_demand_hours_per_day allows). Same template as the Spot group, so a fallback
# instance is the same machine and parks the same way. The volume's single attach is the fence between the two.
locals {
  fallback_types = coalesce(var.fallback.types, var.instance.types)
}

resource "aws_autoscaling_group" "fallback" {
  count = var.fallback.enabled ? 1 : 0

  name                      = local.names.fallback_group
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
      on_demand_percentage_above_base_capacity = 100
      on_demand_allocation_strategy            = "prioritized"
    }
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.box["group"].id
        version            = "$Latest"
      }
      dynamic "override" {
        for_each = local.fallback_types
        content {
          instance_type = override.value
        }
      }
    }
  }

  dynamic "tag" {
    for_each = merge(local.tags, { Name = local.name, (local.role_tag) = "fallback" })
    content {
      key                 = tag.key
      value               = tag.value
      propagate_at_launch = true
    }
  }

  lifecycle {
    ignore_changes = [desired_capacity] # the control function and the box own it after creation
  }
}
