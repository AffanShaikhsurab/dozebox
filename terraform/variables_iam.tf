variable "iam_permissions_boundary" {
  description = "ARN of a managed policy set as the permissions boundary of every IAM role the module creates; null for none. For accounts whose deploy principal may only create bounded roles."
  type        = string
  default     = null
  validation {
    condition     = var.iam_permissions_boundary == null || can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:policy/[A-Za-z0-9+=,.@_/-]{1,512}$", var.iam_permissions_boundary))
    error_message = "iam_permissions_boundary must be a managed policy ARN (arn:<partition>:iam::<account>:policy/<name>) or null."
  }
}
