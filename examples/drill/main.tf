# The stack every drill deploys in the test account (part 10 §10.1.1). Small and cheap: t4g, a 20 GB volume, short
# idle times, tight caps. Each run passes its own box_id (up to 20 characters, the IAM size worst case).
terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
  }
}

variable "box_id" {
  description = "drill-<run>, up to 20 characters."
  type        = string
}

variable "agent_version" {
  description = "Agent release, or none for user data that only logs and powers off."
  type        = string
  default     = "none"
}

variable "alert_email" {
  description = "Where the drill stack's alerts go; null for none."
  type        = string
  default     = null
}

variable "control_bundle_path" {
  description = "The built control bundle (absolute path to packages/control/dist/control.zip); null deploys the placeholder that answers 503."
  type        = string
  default     = null
}

variable "front_door" {
  description = "Put CloudFront and WAF in front of the control API."
  type        = bool
  default     = false
}

variable "iam_permissions_boundary" {
  description = "Permissions boundary on every role; the test account's deploy user may only create bounded roles."
  type        = string
  default     = "arn:aws:iam::111122223333:policy/dozebox-test-boundary"
}

variable "network" {
  description = "The module's network input. The default creates a VPC; an account that may not create one passes an existing VPC and subnet (TF_VAR_network)."
  type = object({
    create     = optional(bool, true)
    vpc_id     = optional(string)
    subnet_ids = optional(list(string), [])
  })
  default = {}
}

variable "marker_nonce" {
  description = "Written by the marker payload into /data/payloads/marker/nonce on its first start; the smoke drill reads it back."
  type        = string
  default     = "drill-nonce"
}

variable "agent_artifact_base_url" {
  description = "Where stage 0 downloads the agent release (https); null for the module default."
  type        = string
  default     = null
}

variable "agent_sha256" {
  description = "SHA-256 of the agent tarball per arch (arm64, x86_64), from the release's SHA256SUMS."
  type        = map(string)
  default     = null
}

variable "region" {
  description = "Test account region."
  type        = string
  default     = "us-east-1"
}

variable "test_tag" {
  description = "Value of the dozebox:test tag on every resource, so a sweep finds what a run left behind."
  type        = string
  default     = "drill"
}

locals {
  # On every resource: default_tags for most, and the module's tags input for what default_tags cannot reach (launch
  # template tag specifications, so instances, volumes, ENIs and Spot requests are tagged on create, and group tags).
  marker = jsondecode(file("${path.module}/../payloads/marker.json"))
  # The nonce reaches the payload through its start env.
  marker_payload = merge(local.marker, {
    start = merge(local.marker.start, { env = merge(local.marker.start.env, { MARKER_NONCE = var.marker_nonce }) })
  })

  test_tags = {
    "dozebox:test"  = var.test_tag
    "dozebox:owner" = "orchestrator"
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = local.test_tags
  }
}

module "dozebox" {
  source = "../../terraform"

  box_id                   = var.box_id
  tags                     = local.test_tags
  iam_permissions_boundary = var.iam_permissions_boundary
  control_bundle_path      = var.control_bundle_path

  instance = {
    types        = ["t4g.small", "t4g.medium"]
    arch         = "arm64"
    machine_mode = "persistent"
  }
  network     = var.network
  data_volume = { size_gb = 20 }
  snapshots   = { every_hours = 24, keep = 2, recycle_bin_days = 1 }

  idle_minutes             = 5
  no_progress_park_minutes = 30

  caps = {
    awake_hours_per_day     = 2
    on_demand_hours_per_day = 1
    monthly_budget_usd      = 25
    max_spot_price_per_hour = 0.03
  }

  alerts             = { email = var.alert_email }
  front_door_enabled = var.front_door
  fis_enabled        = true
  enable_ssm_session = true # the drill reads /data through SSM Run Command

  drill_mode = true # test-only: the data volume has no prevent_destroy, so the drill can tear down

  payloads = {
    marker = local.marker_payload
  }
  agent = {
    version = var.agent_version
    # A drill stack points at its own pre-release (warm.auto.tfvars.json); the public default otherwise.
    artifact_base_url = coalesce(var.agent_artifact_base_url, "https://github.com/dozebox/dozebox/releases/download/v${var.agent_version}")
    sha256            = var.agent_sha256
  }
}

output "box_id" {
  description = "The drill's box id."
  value       = module.dozebox.box_id
}

output "ssm_prefix" {
  description = "/dozebox/<box_id>/."
  value       = module.dozebox.ssm_prefix
}

output "alert_topic_arn" {
  description = "SNS topic."
  value       = module.dozebox.alert_topic_arn
}

output "data_volume_id" {
  description = "The data volume."
  value       = module.dozebox.data_volume_id
}

output "persistent_instance_id" {
  description = "The persistent Spot instance."
  value       = module.dozebox.persistent_instance_id
}

output "iam_policy_sizes" {
  description = "Characters of every managed policy."
  value       = module.dozebox.iam_policy_sizes
}

output "control_url" {
  description = "Base URL of the control API."
  value       = module.dozebox.control_url
}

output "control_function_name" {
  description = "The control function."
  value       = module.dozebox.control_function_name
}

output "wake_token_parameter" {
  description = "Name of the wake token SecureString."
  value       = module.dozebox.wake_token_parameter
}

output "state_table_name" {
  description = "DynamoDB state table."
  value       = module.dozebox.state_table_name
}

output "unfreeze_runbook" {
  description = "The unfreeze SSM Automation document and its parameters."
  value       = module.dozebox.unfreeze_runbook
}

output "region" {
  description = "The stack's region."
  value       = module.dozebox.region
}

output "tag_prefix" {
  description = "Tag key prefix."
  value       = module.dozebox.tag_prefix
}

output "instance_role_arn" {
  description = "The box role."
  value       = module.dozebox.instance_role_arn
}

output "front_door_domain_name" {
  description = "CloudFront domain, or null without the front door."
  value       = module.dozebox.front_door_domain_name
}

output "marker_nonce" {
  description = "The marker payload's nonce (the smoke drill compares /data/payloads/marker/nonce with it)."
  value       = var.marker_nonce
}