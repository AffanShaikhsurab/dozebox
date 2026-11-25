variable "region" {
  description = "Region of the state bucket and of the stacks the deploy principal applies."
  type        = string
  default     = "us-east-1"
  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.region))
    error_message = "region must look like us-east-1."
  }
}

variable "name_prefix" {
  description = "The module's name_prefix. The deploy policies reach only resources named <prefix>-* and SSM paths /<prefix>/*."
  type        = string
  default     = "dozebox"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.name_prefix))
    error_message = "name_prefix must match ^[a-z][a-z0-9-]{1,15}$ (as in the module)."
  }
}

variable "state_bucket_name" {
  description = "State bucket name; null for <prefix>-tfstate-<account>-<region>. Bucket names are global."
  type        = string
  default     = null
}

variable "deploy_role_name" {
  description = "Name of an existing role (the deploy principal) to attach the deploy policies to; null to only create them."
  type        = string
  default     = null
}

variable "tags" {
  description = "Added to every resource."
  type        = map(string)
  default     = {}
}
