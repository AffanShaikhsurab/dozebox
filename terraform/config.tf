# The box config (part 5 §5.4) and one parameter per payload definition. The agent reads both at boot and every
# 5 minutes; the TypeBox schema BoxConfig in @dozebox/protocol is the contract for local.box_config.
locals {
  box_config = {
    schema = 1
    box    = { id = var.box_id, prefix = var.name_prefix, region = local.region }
    brand  = { name = "Dozebox", alertSubject = "Dozebox: ${var.box_id}" }
    idle = {
      idleMinutes           = var.idle_minutes
      viewingGraceMinutes   = 10
      noProgressParkMinutes = var.no_progress_park_minutes
    }
    health   = { checkEverySeconds = 60, restartAtStrikes = [5, 10], parkAtStrikes = 15, restartsPerHour = 2 }
    failsafe = { bootDeadlineMinutes = 60, everyMinutes = 15 }
    caps     = { awakeHoursPerDay = var.caps.awake_hours_per_day }
    disk     = { lowPct = 15, criticalPct = 5, hysteresisPct = 3 }
    alerts   = { topicArn = local.arns.alert_topic, dedupeSeconds = 3600 }
    logs     = { group = local.names.box_log_group, dailyBudgetMiB = 100 }
    presenceSources = {
      ssh      = true
      tcpPorts = []
    }
    jail     = { enabled = var.jail.enabled, egress = var.jail.egress, allowHosts = var.jail.allow_hosts }
    tripwire = { enabled = var.tripwire_enabled }
    payloads = sort(keys(var.payloads))
  }
}

# Intelligent-Tiering stores the parameter as Standard (free) and moves it to Advanced only when it outgrows 4 KiB.
resource "aws_ssm_parameter" "config" {
  name  = "${local.ssm_prefix}config"
  type  = "String"
  tier  = "Intelligent-Tiering"
  value = jsonencode(local.box_config)
  tags  = local.tags
}

resource "aws_ssm_parameter" "payload" {
  for_each = var.payloads

  name  = "${local.ssm_prefix}payloads/${each.key}"
  type  = "String"
  tier  = "Intelligent-Tiering"
  value = jsonencode(each.value)
  tags  = local.tags
}
