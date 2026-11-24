# Configuration

The Terraform module in `terraform/` is configured by the inputs below. Objects take `optional(...)` fields, so set
only what you need. `examples/minimal` is the smallest working stack; `examples/drill` is the test-account stack.

Secrets are never inputs. Fields that end in `secret` take the name of a SecureString under `/<prefix>/shared/`.

<!-- BEGIN_TF_DOCS -->
### Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| box\_id | Box id, used in names, SSM paths and tags. | `string` | `"main"` | no |
| name\_prefix | Prefix of every resource name, SSM path and tag key. | `string` | `"dozebox"` | no |
| instance | Instance types (first is preferred), CPU architecture, machine mode, AMI parameter (default: Canonical Ubuntu 24.04 for the arch) and root disk size. | ```object({ types = list(string) arch = optional(string, "arm64") machine_mode = optional(string, "persistent") ami_ssm_parameter = optional(string) root_volume_gb = optional(number, 30) })``` | n/a | yes |
| network | Create a VPC (default) or use an existing one. No inbound rule unless ssh\_cidrs is set. | ```object({ create = optional(bool, true) vpc_id = optional(string) subnet_ids = optional(list(string), []) ssh_cidrs = optional(list(string), []) })``` | `{}` | no |
| data\_volume | The encrypted gp3 data volume that holds all payload state. | ```object({ size_gb = number iops = optional(number, 3000) throughput = optional(number, 125) kms_key_arn = optional(string) })``` | n/a | yes |
| snapshots | DLM snapshot interval and retention, Recycle Bin days, and how long a retired volume is kept. | ```object({ every_hours = optional(number, 24) keep = optional(number, 7) recycle_bin_days = optional(number, 7) retired_volume_days = optional(number, 14) })``` | `{}` | no |
| idle\_minutes | Minutes without activity or presence before the box parks itself. | `number` | `30` | no |
| no\_progress\_park\_minutes | Minutes without payload progress before the box parks even when a hold is open. | `number` | `150` | no |
| caps | Hard limits on awake time, On-Demand time and monthly spend. | ```object({ awake_hours_per_day = optional(number) on_demand_hours_per_day = optional(number, 3) monthly_budget_usd = number max_spot_price_per_hour = optional(number) freeze_on_budget = optional(bool, true) })``` | n/a | yes |
| fallback | The On-Demand fallback group. unattended = true lets scheduled and event wakes use On-Demand. | ```object({ enabled = optional(bool, true) unattended = optional(bool, false) types = optional(list(string)) })``` | `{}` | no |
| alerts | Where alerts go. Secret fields are names under /<prefix>/shared/, never values. | ```object({ email = optional(string) ntfy_secret = optional(string) web_push = optional(bool, true) webhook_secret = optional(string) healthchecks_secret = optional(string) })``` | `{}` | no |
| front\_door\_enabled | CloudFront with OAC and WAF in front of the control Function URL. | `bool` | `true` | no |
| waf\_rate\_limit\_per\_5min | Requests per 5 minutes per client address before the WAF rate rule blocks. | `number` | `300` | no |
| wake\_sources | Outside wake sources. Secrets are names under /<prefix>/shared/, never values. | ```object({ github = optional(object({ enabled = bool, secret = string })) generic = optional(object({ enabled = bool, secret = string })) })``` | `{}` | no |
| wake\_budget | Most outside-event wakes per hour and per day. | ```object({ per_hour = optional(number, 6) per_day = optional(number, 24) })``` | `{}` | no |
| payloads | Payload definitions by name (part 5 §5.5). The agent validates each at boot. | `any` | n/a | yes |
| agent | Agent release. version = "none" renders user data that only logs and powers off (test stacks). | ```object({ version = string artifact_base_url = optional(string) sha256 = optional(map(string)) })``` | n/a | yes |
| jail | Jail for agents the payload launches, and its egress mode. | ```object({ enabled = optional(bool, true) egress = optional(string, "imds-only") allow_hosts = optional(list(string), []) })``` | `{}` | no |
| tripwire\_enabled | Decoy key and CloudTrail data path. | `bool` | `true` | no |
| restore\_test | Weekly restore test of the latest snapshot on a throwaway instance. | ```object({ enabled = optional(bool, true) schedule = optional(string, "cron(0 4 ? * SUN *)") close_after_hours = optional(number, 2) })``` | `{}` | no |
| fis\_enabled | FIS templates for drills, with a stop condition on the cap alarm. | `bool` | `false` | no |
| log\_retention\_days | Retention of every log group the module creates. | `number` | `30` | no |
| enable\_ssm\_session | Adds the scoped Session Manager policy to the instance role. | `bool` | `false` | no |
| tags | Added to every resource. The module adds <prefix>:box = <box\_id>. | `map(string)` | `{}` | no |

### Outputs

| Name | Description |
|------|-------------|
| box\_id | The box id. |
| region | The region the stack is in. |
| control\_function\_name | For aws lambda invoke admin calls. |
| ssm\_prefix | /<prefix>/<box\_id>/. |
| wake\_token\_parameter | Name of the SecureString holding the wake token (not the value). |
| alert\_topic\_arn | SNS topic. |
| instance\_role\_arn | Role of the box. |
| state\_table\_name | DynamoDB table (lease, outbox, ledgers). |
| dashboard\_url | CloudWatch dashboard. |
<!-- END_TF_DOCS -->
