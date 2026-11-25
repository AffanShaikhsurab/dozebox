# Inputs about how the stack is deployed rather than how the box behaves: the control bundle (the IAM boundary is in variables_iam.tf).
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
