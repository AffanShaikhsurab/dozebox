# Every input validation rejects its bad values, and a minimal input set plans with the module's names and tags.
# Offline: the AWS provider is mocked; the data sources are overridden with real-shaped values.
mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "111122223333" }
  }
  override_data {
    target = data.aws_region.current
    values = { region = "us-east-1" }
  }
  override_data {
    target = data.aws_partition.current
    values = { partition = "aws" }
  }
}

variables {
  box_id      = "main"
  instance    = { types = ["t4g.small"] }
  data_volume = { size_gb = 20 }
  caps        = { monthly_budget_usd = 10 }
  payloads = {
    demo = { schema = 1, name = "demo", user = "demo", protocol = "none", start = { command = ["/bin/true"] } }
  }
  agent = { version = "none" }
}

run "minimal_inputs_plan" {
  command = plan

  assert {
    condition     = local.name == "dozebox-main" && local.ssm_prefix == "/dozebox/main/"
    error_message = "Names must be <prefix>-<box> and the SSM prefix /<prefix>/<box>/."
  }
  assert {
    condition     = aws_sns_topic.alerts.tags["dozebox:box"] == "main"
    error_message = "Every resource carries <prefix>:box = <box_id>."
  }
  assert {
    condition     = jsondecode(aws_ssm_parameter.config.value).box == { id = "main", prefix = "dozebox", region = "us-east-1" }
    error_message = "The box config names the box, prefix and region."
  }
  assert {
    condition     = jsondecode(aws_ssm_parameter.config.value).payloads == ["demo"] && aws_ssm_parameter.payload["demo"].name == "/dozebox/main/payloads/demo"
    error_message = "Each payload definition gets /<prefix>/<box>/payloads/<name>, and the config lists the names."
  }
  assert {
    condition     = jsondecode(aws_ssm_parameter.config.value).alerts.topicArn == "arn:aws:sns:us-east-1:111122223333:dozebox-main-alerts"
    error_message = "The config's topic ARN must be the alert topic's ARN."
  }
  assert {
    condition     = local.ami_ssm_parameter == "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
    error_message = "arm64 boxes default to the Canonical arm64 Ubuntu 24.04 parameter."
  }
  assert {
    condition     = length(aws_sns_topic_subscription.email) == 0
    error_message = "No email subscription without alerts.email."
  }
}

run "prefix_and_tags_rename_everything" {
  command = plan
  variables {
    box_id      = "second"
    name_prefix = "acme"
    instance    = { types = ["m7i.large"], arch = "x86_64" }
    tags        = { project = "agents" }
    alerts      = { email = "ops@example.com" }
  }

  assert {
    condition     = aws_iam_role.box.name == "acme-second-box" && aws_sns_topic.alerts.name == "acme-second-alerts"
    error_message = "name_prefix and box_id must rename every resource."
  }
  assert {
    condition     = aws_sns_topic.alerts.tags == tomap({ "acme:box" = "second", project = "agents" })
    error_message = "Tags are var.tags plus <prefix>:box."
  }
  assert {
    condition     = local.ami_ssm_parameter == "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
    error_message = "x86_64 boxes default to the Canonical amd64 parameter."
  }
  assert {
    condition     = length(aws_sns_topic_subscription.email) == 1
    error_message = "alerts.email subscribes the address to the topic."
  }
}

run "payload_secrets_are_collected_by_name" {
  command = plan
  variables {
    payloads = {
      one = { schema = 1, name = "one", user = "one", protocol = "none", start = { command = ["/bin/true"] },
      secrets = [{ name = "gh-token", as = { env = "GH_TOKEN" } }, { name = "api-key", as = { file = "key" } }] }
      two = { schema = 1, name = "two", user = "two", protocol = "v1", start = { command = ["/bin/true"], env = { A = "1" } },
      secrets = [{ name = "gh-token", as = { env = "GH_TOKEN" } }] }
    }
  }

  assert {
    condition     = local.payload_secret_names == tolist(["api-key", "gh-token"])
    error_message = "Payloads of different shapes are accepted and their secret names collected, sorted and distinct."
  }
}

run "warns_without_an_alert_path" {
  command = plan
  variables {
    alerts = { web_push = false }
  }
  expect_failures = [check.an_alert_path_is_set]
}
run "rejects_box_id_uppercase" {
  command = plan
  variables {
    box_id = "Main"
  }
  expect_failures = [var.box_id]
}

run "rejects_box_id_leading_dash" {
  command = plan
  variables {
    box_id = "-main"
  }
  expect_failures = [var.box_id]
}

run "rejects_box_id_21_chars" {
  command = plan
  variables {
    box_id = "a23456789012345678901"
  }
  expect_failures = [var.box_id]
}

run "rejects_name_prefix_too_short" {
  command = plan
  variables {
    name_prefix = "d"
  }
  expect_failures = [var.name_prefix]
}

run "rejects_name_prefix_digit_first" {
  command = plan
  variables {
    name_prefix = "1dozebox"
  }
  expect_failures = [var.name_prefix]
}

run "rejects_instance_no_types" {
  command = plan
  variables {
    instance = { types = [] }
  }
  expect_failures = [var.instance]
}

run "rejects_instance_11_types" {
  command = plan
  variables {
    instance = { types = ["a.b", "a.c", "a.d", "a.e", "a.f", "a.g", "a.h", "a.i", "a.j", "a.k", "a.l"] }
  }
  expect_failures = [var.instance]
}

run "rejects_instance_bad_type" {
  command = plan
  variables {
    instance = { types = ["t4g small"] }
  }
  expect_failures = [var.instance]
}

run "rejects_instance_bad_arch" {
  command = plan
  variables {
    instance = { types = ["t4g.small"], arch = "arm" }
  }
  expect_failures = [var.instance]
}

run "rejects_instance_bad_mode" {
  command = plan
  variables {
    instance = { types = ["t4g.small"], machine_mode = "spot" }
  }
  expect_failures = [var.instance]
}

run "rejects_instance_tiny_root" {
  command = plan
  variables {
    instance = { types = ["t4g.small"], root_volume_gb = 4 }
  }
  expect_failures = [var.instance]
}

run "rejects_network_existing_without_ids" {
  command = plan
  variables {
    network = { create = false }
  }
  expect_failures = [var.network]
}

run "rejects_network_bad_ssh_cidr" {
  command = plan
  variables {
    network = { ssh_cidrs = ["anywhere"] }
  }
  expect_failures = [var.network]
}

run "rejects_data_volume_too_small" {
  command = plan
  variables {
    data_volume = { size_gb = 10 }
  }
  expect_failures = [var.data_volume]
}

run "rejects_data_volume_too_big" {
  command = plan
  variables {
    data_volume = { size_gb = 5000 }
  }
  expect_failures = [var.data_volume]
}

run "rejects_data_volume_low_iops" {
  command = plan
  variables {
    data_volume = { size_gb = 20, iops = 100 }
  }
  expect_failures = [var.data_volume]
}

run "rejects_data_volume_low_throughput" {
  command = plan
  variables {
    data_volume = { size_gb = 20, throughput = 50 }
  }
  expect_failures = [var.data_volume]
}

run "rejects_data_volume_bad_kms" {
  command = plan
  variables {
    data_volume = { size_gb = 20, kms_key_arn = "alias/mine" }
  }
  expect_failures = [var.data_volume]
}

run "rejects_snapshots_bad_interval" {
  command = plan
  variables {
    snapshots = { every_hours = 5 }
  }
  expect_failures = [var.snapshots]
}

run "rejects_snapshots_keep_zero" {
  command = plan
  variables {
    snapshots = { keep = 0 }
  }
  expect_failures = [var.snapshots]
}

run "rejects_snapshots_recycle_zero" {
  command = plan
  variables {
    snapshots = { recycle_bin_days = 0 }
  }
  expect_failures = [var.snapshots]
}

run "rejects_snapshots_retired_zero" {
  command = plan
  variables {
    snapshots = { retired_volume_days = 0 }
  }
  expect_failures = [var.snapshots]
}

run "rejects_idle_minutes_too_low" {
  command = plan
  variables {
    idle_minutes = 4
  }
  expect_failures = [var.idle_minutes]
}

run "rejects_idle_minutes_too_high" {
  command = plan
  variables {
    idle_minutes = 721
  }
  expect_failures = [var.idle_minutes]
}

run "rejects_no_progress_too_low" {
  command = plan
  variables {
    no_progress_park_minutes = 29
  }
  expect_failures = [var.no_progress_park_minutes]
}

run "rejects_caps_zero_budget" {
  command = plan
  variables {
    caps = { monthly_budget_usd = 0 }
  }
  expect_failures = [var.caps]
}

run "rejects_caps_awake_over_24" {
  command = plan
  variables {
    caps = { monthly_budget_usd = 10, awake_hours_per_day = 25 }
  }
  expect_failures = [var.caps]
}

run "rejects_caps_negative_on_demand" {
  command = plan
  variables {
    caps = { monthly_budget_usd = 10, on_demand_hours_per_day = -1 }
  }
  expect_failures = [var.caps]
}

run "rejects_caps_zero_spot_price" {
  command = plan
  variables {
    caps = { monthly_budget_usd = 10, max_spot_price_per_hour = 0 }
  }
  expect_failures = [var.caps]
}

run "rejects_fallback_empty_types" {
  command = plan
  variables {
    fallback = { types = [] }
  }
  expect_failures = [var.fallback]
}

run "rejects_fallback_types_not_subset" {
  command = plan
  variables {
    fallback = { types = ["m7g.large"] }
  }
  expect_failures = [var.fallback]
}

run "rejects_alerts_bad_email" {
  command = plan
  variables {
    alerts = { email = "not-an-email" }
  }
  expect_failures = [var.alerts]
}

run "rejects_alerts_secret_value_not_name" {
  command = plan
  variables {
    alerts = { ntfy_secret = "https://ntfy.sh/secret" }
  }
  expect_failures = [var.alerts]
}

run "rejects_waf_rate_too_low" {
  command = plan
  variables {
    waf_rate_limit_per_5min = 5
  }
  expect_failures = [var.waf_rate_limit_per_5min]
}

run "rejects_wake_source_secret_value" {
  command = plan
  variables {
    wake_sources = { github = { enabled = true, secret = "ghp_Value With Spaces" } }
  }
  expect_failures = [var.wake_sources]
}

run "rejects_wake_budget_zero_per_hour" {
  command = plan
  variables {
    wake_budget = { per_hour = 0 }
  }
  expect_failures = [var.wake_budget]
}

run "rejects_wake_budget_day_below_hour" {
  command = plan
  variables {
    wake_budget = { per_hour = 10, per_day = 5 }
  }
  expect_failures = [var.wake_budget]
}

run "rejects_payloads_empty" {
  command = plan
  variables {
    payloads = {}
  }
  expect_failures = [var.payloads]
}

run "rejects_payloads_bad_name" {
  command = plan
  variables {
    payloads = { Demo = { schema = 1 } }
  }
  expect_failures = [var.payloads]
}

run "rejects_agent_bad_version" {
  command = plan
  variables {
    agent = { version = "latest" }
  }
  expect_failures = [var.agent]
}

run "rejects_agent_http_base_url" {
  command = plan
  variables {
    agent = { version = "1.0.0", artifact_base_url = "http://example.com" }
  }
  expect_failures = [var.agent]
}

run "rejects_agent_bad_sha256" {
  command = plan
  variables {
    agent = { version = "1.0.0", sha256 = { arm64 = "abc" } }
  }
  expect_failures = [var.agent]
}

run "rejects_jail_bad_egress" {
  command = plan
  variables {
    jail = { egress = "open" }
  }
  expect_failures = [var.jail]
}

run "rejects_restore_test_bad_schedule" {
  command = plan
  variables {
    restore_test = { schedule = "weekly" }
  }
  expect_failures = [var.restore_test]
}

run "rejects_restore_test_zero_close" {
  command = plan
  variables {
    restore_test = { close_after_hours = 0 }
  }
  expect_failures = [var.restore_test]
}

run "rejects_log_retention_not_allowed" {
  command = plan
  variables {
    log_retention_days = 2
  }
  expect_failures = [var.log_retention_days]
}

run "rejects_tags_aws_prefix" {
  command = plan
  variables {
    tags = { "aws:owner" = "me" }
  }
  expect_failures = [var.tags]
}

run "rejects_tags_box_key" {
  command = plan
  variables {
    tags = { "dozebox:box" = "other" }
  }
  expect_failures = [var.tags]
}
