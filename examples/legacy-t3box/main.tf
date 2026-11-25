# A stack built by the old runner adopts the module without renaming anything: the old prefixes keep every resource
# name, SSM path and tag key. Generate the state moves from the old root, then review `terraform plan` (no destroy):
#   terraform state list | node scripts/gen-moved.ts > moved.tf
terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
  }
}

variable "region" {
  description = "AWS region of the stack."
  type        = string
  default     = "us-east-1"
}

variable "alert_email" {
  description = "Where alerts go."
  type        = string
}

provider "aws" {
  region = var.region
}

module "dozebox" {
  source = "../../terraform"

  name_prefix = "t3box"
  box_id      = "main"
  ssm_prefix  = "/t3box/main/"
  tag_prefix  = "t3box"

  instance    = { types = ["t4g.medium", "t4g.large"] }
  data_volume = { size_gb = 50 }
  caps        = { monthly_budget_usd = 30 }
  alerts      = { email = var.alert_email }
  payloads    = { marker = jsondecode(file("${path.module}/../payloads/marker.json")) }
  agent       = { version = "none" }
}

output "stack" {
  description = "Everything the CLI reads from the stack."
  value       = module.dozebox
}
