# Inputs about how the stack is deployed rather than how the box behaves: the control bundle and the IAM boundary.
# (variables.tf holds the inputs of part 5 §5.2 and is at the 400-line budget.)
variable "control_bundle_path" {
  description = "Zip of the control function (control.mjs exporting handler). Null deploys a placeholder that answers 503 not_deployed."
  type        = string
  default     = null

  validation {
    condition     = var.control_bundle_path == null ? true : endswith(var.control_bundle_path, ".zip")
    error_message = "control_bundle_path must name a .zip file."
  }
}

variable "iam_permissions_boundary" {
  description = "ARN of a permissions boundary for every role the module creates, or null for none."
  type        = string
  default     = null

  validation {
    condition     = var.iam_permissions_boundary == null ? true : can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:policy/", var.iam_permissions_boundary))
    error_message = "iam_permissions_boundary must be an IAM policy ARN."
  }
}
