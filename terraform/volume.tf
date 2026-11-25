# The data volume holds all payload state. A gp3 volume attaches to one instance at a time, and that single attach is
# the fence between the persistent instance and the fallback. `<prefix>:active = true` marks the one volume a box may
# attach (the box role's AttachVolume condition reads it); restore and move-az retag the old one, so Terraform
# ignores the tags after creation (ignore_changes cannot name a tag key built from the prefix).
locals {
  data_volume_tags = merge(local.tags, {
    Name                         = local.names.data_volume
    "${local.tag_prefix}:active" = "true"
  })
  data_volume = var.drill_mode ? aws_ebs_volume.data_unguarded[0] : aws_ebs_volume.data[0]
}

resource "aws_ebs_volume" "data" {
  count             = var.drill_mode ? 0 : 1
  availability_zone = local.home_az
  size              = var.data_volume.size_gb
  type              = "gp3"
  iops              = var.data_volume.iops
  throughput        = var.data_volume.throughput
  encrypted         = true
  kms_key_id        = var.data_volume.kms_key_arn
  tags              = local.data_volume_tags

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [tags, tags_all]
  }
}

# Test stacks only (drill_mode = true): the same volume without prevent_destroy, so a drill can tear down.
resource "aws_ebs_volume" "data_unguarded" {
  count             = var.drill_mode ? 1 : 0
  availability_zone = local.home_az
  size              = var.data_volume.size_gb
  type              = "gp3"
  iops              = var.data_volume.iops
  throughput        = var.data_volume.throughput
  encrypted         = true
  kms_key_id        = var.data_volume.kms_key_arn
  tags              = local.data_volume_tags

  lifecycle {
    ignore_changes = [tags, tags_all]
  }
}

# DLM snapshots every snapshots.every_hours and keeps snapshots.keep. It targets by Name, which restore and move-az
# give the new volume too; DLM matches any of its target tags, so a shared tag like <prefix>:box would also take the
# disposable root disks.
resource "aws_dlm_lifecycle_policy" "snapshots" {
  description        = "${local.name} data volume snapshots"
  execution_role_arn = aws_iam_role.snapshots.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { Name = local.names.data_volume }

    schedule {
      name      = "every-${var.snapshots.every_hours}h"
      copy_tags = true
      create_rule {
        interval      = var.snapshots.every_hours
        interval_unit = "HOURS"
        times         = ["03:00"]
      }
      retain_rule {
        count = var.snapshots.keep
      }
      tags_to_add = { "${local.tag_prefix}:snapshot" = "dlm" }
    }
  }

  tags = merge(local.tags, { Name = "${local.name}-snapshots" })
}

# A snapshot of this box deleted by mistake stays recoverable for snapshots.recycle_bin_days.
resource "aws_rbin_rule" "snapshots" {
  description   = "${local.name}: deleted snapshots stay recoverable for ${var.snapshots.recycle_bin_days} days"
  resource_type = "EBS_SNAPSHOT"

  resource_tags {
    resource_tag_key   = "${local.tag_prefix}:box"
    resource_tag_value = var.box_id
  }

  retention_period {
    retention_period_unit  = "DAYS"
    retention_period_value = var.snapshots.recycle_bin_days
  }

  tags = local.tags
}
