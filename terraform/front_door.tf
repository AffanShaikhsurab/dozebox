# T7 (front door: CloudFront + OAC + WAF in front of the Function URL). Contracts step: outputs only; T7 adds the
# distribution, the origin access control, the origin request policy (x-dozebox-token and the legacy alias) and the
# web ACL here, gated on var.front_door_enabled and var.waf_rate_limit_per_5min (variables.tf).

output "front_door_domain_name" {
  description = "CloudFront domain of the front door, or null when it is off (or not built yet)."
  value       = null
}

output "front_door_distribution_id" {
  description = "CloudFront distribution id, or null when the front door is off (or not built yet)."
  value       = null
}

output "waf_web_acl_arn" {
  description = "WAF web ACL in front of the control API, or null when the front door is off (or not built yet)."
  value       = null
}
