# T6 (legacy names): overrides that let an existing stack keep its SSM paths and tag keys. main.tf locals read them.

variable "ssm_prefix" {
  description = "SSM path prefix override, such as /legacy/main/. Null: /<name_prefix>/<box_id>/."
  type        = string
  default     = null

  validation {
    condition     = var.ssm_prefix == null || can(regex("^/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*/$", var.ssm_prefix))
    error_message = "ssm_prefix must start and end with / and use only letters, digits, _, . and -."
  }
}

variable "tag_prefix" {
  description = "Tag key prefix override for the <prefix>:box, :role and :active tags. Null: name_prefix."
  type        = string
  default     = null

  validation {
    condition     = var.tag_prefix == null || can(regex("^[a-z][a-z0-9-]{1,15}$", var.tag_prefix))
    error_message = "tag_prefix must match ^[a-z][a-z0-9-]{1,15}$."
  }
}

output "tag_prefix" {
  description = "The tag key prefix in use."
  value       = local.tag_prefix
}
