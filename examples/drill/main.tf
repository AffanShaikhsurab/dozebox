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

  instance = {
    types        = ["t4g.small", "t4g.medium"]
    arch         = "arm64"
    machine_mode = "persistent"
  }
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
    marker = jsondecode(file("${path.module}/../payloads/marker.json"))
  }
  agent = { version = var.agent_version }
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
