# The module applied against the local AWS emulator (test rung 2). Point AWS_ENDPOINT_URL at it, with the emulator's
# own keys in the environment. agent.version = "none" keeps user data tiny, and the AMI parameter is one the emulator
# can seed, because /aws/service/... is reserved.
terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
  }
}

variable "ami_ssm_parameter" {
  description = "An SSM parameter in the emulator that holds an AMI id."
  type        = string
  default     = "/dozebox-emulator/ami-id"
}

provider "aws" {
  region                      = "us-east-1"
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  skip_requesting_account_id  = false
}

module "dozebox" {
  source = "../../terraform"

  box_id = "emulator"

  instance = {
    types             = ["t4g.small"]
    ami_ssm_parameter = var.ami_ssm_parameter
  }
  data_volume        = { size_gb = 20 }
  caps               = { monthly_budget_usd = 10 }
  front_door_enabled = false
  tripwire_enabled   = false
  restore_test       = { enabled = false }

  payloads = {
    marker = jsondecode(file("${path.module}/../payloads/marker.json"))
  }
  agent = { version = "none" }
}

output "stack" {
  description = "Every module output, for the emulator test to compare."
  value       = module.dozebox
}
