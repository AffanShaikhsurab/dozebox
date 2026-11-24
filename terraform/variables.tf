variable "box_id" {
  description = "Box id, used in names, SSM paths and tags."
  type        = string
  default     = "main"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,19}$", var.box_id))
    error_message = "box_id must match ^[a-z0-9][a-z0-9-]{0,19}$."
  }
}

variable "name_prefix" {
  description = "Prefix of every resource name, SSM path and tag key."
  type        = string
  default     = "dozebox"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.name_prefix))
    error_message = "name_prefix must match ^[a-z][a-z0-9-]{1,15}$."
  }
}

variable "instance" {
  description = "Instance types (first is preferred), CPU architecture, machine mode, AMI parameter (default: Canonical Ubuntu 24.04 for the arch) and root disk size."
  type = object({
    types             = list(string)
    arch              = optional(string, "arm64")
    machine_mode      = optional(string, "persistent")
    ami_ssm_parameter = optional(string)
    root_volume_gb    = optional(number, 30)
  })

  validation {
    condition     = length(var.instance.types) >= 1 && length(var.instance.types) <= 10
    error_message = "instance.types must list 1 to 10 instance types."
  }
  validation {
    condition     = alltrue([for t in var.instance.types : can(regex("^[a-z0-9-]+\\.[a-z0-9]+$", t))])
    error_message = "instance.types entries must look like an instance type, such as t4g.small."
  }
  validation {
    condition     = contains(["arm64", "x86_64"], var.instance.arch)
    error_message = "instance.arch must be arm64 or x86_64."
  }
  validation {
    condition     = contains(["persistent", "group"], var.instance.machine_mode)
    error_message = "instance.machine_mode must be persistent or group."
  }
  validation {
    condition     = var.instance.root_volume_gb >= 8 && var.instance.root_volume_gb <= 1024
    error_message = "instance.root_volume_gb must be between 8 and 1024."
  }
}

variable "network" {
  description = "Create a VPC (default) or use an existing one. No inbound rule unless ssh_cidrs is set."
  type = object({
    create     = optional(bool, true)
    vpc_id     = optional(string)
    subnet_ids = optional(list(string), [])
    ssh_cidrs  = optional(list(string), [])
  })
  default = {}

  validation {
    condition     = var.network.create || (var.network.vpc_id != null && length(var.network.subnet_ids) > 0)
    error_message = "network.vpc_id and network.subnet_ids are required when network.create is false."
  }
  validation {
    condition     = alltrue([for c in var.network.ssh_cidrs : can(cidrhost(c, 0))])
    error_message = "network.ssh_cidrs entries must be CIDR blocks."
  }
}

variable "data_volume" {
  description = "The encrypted gp3 data volume that holds all payload state."
  type = object({
    size_gb     = number
    iops        = optional(number, 3000)
    throughput  = optional(number, 125)
    kms_key_arn = optional(string)
  })

  validation {
    condition     = var.data_volume.size_gb >= 20 && var.data_volume.size_gb <= 4096
    error_message = "data_volume.size_gb must be between 20 and 4096."
  }
  validation {
    condition     = var.data_volume.iops >= 3000 && var.data_volume.iops <= 80000
    error_message = "data_volume.iops must be between 3000 and 80000 (gp3)."
  }
  validation {
    condition     = var.data_volume.throughput >= 125 && var.data_volume.throughput <= 2000
    error_message = "data_volume.throughput must be between 125 and 2000 MiB/s (gp3)."
  }
  validation {
    condition     = var.data_volume.kms_key_arn == null || can(regex("^arn:aws[a-z-]*:kms:", var.data_volume.kms_key_arn))
    error_message = "data_volume.kms_key_arn must be a KMS key ARN."
  }
}

variable "snapshots" {
  description = "DLM snapshot interval and retention, Recycle Bin days, and how long a retired volume is kept."
  type = object({
    every_hours         = optional(number, 24)
    keep                = optional(number, 7)
    recycle_bin_days    = optional(number, 7)
    retired_volume_days = optional(number, 14)
  })
  default = {}

  validation {
    condition     = contains([1, 2, 3, 4, 6, 8, 12, 24], var.snapshots.every_hours)
    error_message = "snapshots.every_hours must be one of 1, 2, 3, 4, 6, 8, 12, 24 (DLM intervals)."
  }
  validation {
    condition     = var.snapshots.keep >= 1 && var.snapshots.keep <= 1000
    error_message = "snapshots.keep must be between 1 and 1000."
  }
  validation {
    condition     = var.snapshots.recycle_bin_days >= 1 && var.snapshots.recycle_bin_days <= 365
    error_message = "snapshots.recycle_bin_days must be between 1 and 365."
  }
  validation {
    condition     = var.snapshots.retired_volume_days >= 1 && var.snapshots.retired_volume_days <= 365
    error_message = "snapshots.retired_volume_days must be between 1 and 365."
  }
}

variable "idle_minutes" {
  description = "Minutes without activity or presence before the box parks itself."
  type        = number
  default     = 30

  validation {
    condition     = var.idle_minutes >= 5 && var.idle_minutes <= 720
    error_message = "idle_minutes must be between 5 and 720."
  }
}

variable "no_progress_park_minutes" {
  description = "Minutes without payload progress before the box parks even when a hold is open."
  type        = number
  default     = 150

  validation {
    condition     = var.no_progress_park_minutes >= 30 && var.no_progress_park_minutes <= 1440
    error_message = "no_progress_park_minutes must be between 30 and 1440."
  }
}

variable "caps" {
  description = "Hard limits on awake time, On-Demand time and monthly spend."
  type = object({
    awake_hours_per_day     = optional(number)
    on_demand_hours_per_day = optional(number, 3)
    monthly_budget_usd      = number
    max_spot_price_per_hour = optional(number)
    freeze_on_budget        = optional(bool, true)
  })

  validation {
    condition     = var.caps.monthly_budget_usd > 0
    error_message = "caps.monthly_budget_usd must be greater than 0."
  }
  validation {
    condition     = var.caps.awake_hours_per_day == null ? true : (var.caps.awake_hours_per_day > 0 && var.caps.awake_hours_per_day <= 24)
    error_message = "caps.awake_hours_per_day must be greater than 0 and at most 24."
  }
  validation {
    condition     = var.caps.on_demand_hours_per_day >= 0 && var.caps.on_demand_hours_per_day <= 24
    error_message = "caps.on_demand_hours_per_day must be between 0 and 24."
  }
  validation {
    condition     = var.caps.max_spot_price_per_hour == null ? true : var.caps.max_spot_price_per_hour > 0
    error_message = "caps.max_spot_price_per_hour must be greater than 0 when set."
  }
}

variable "fallback" {
  description = "The On-Demand fallback group. unattended = true lets scheduled and event wakes use On-Demand."
  type = object({
    enabled    = optional(bool, true)
    unattended = optional(bool, false)
    types      = optional(list(string))
  })
  default = {}

  validation {
    condition     = var.fallback.types == null ? true : length(var.fallback.types) >= 1
    error_message = "fallback.types must not be empty when set (leave it unset to use instance.types)."
  }
  validation {
    condition     = var.fallback.types == null ? true : length(setsubtract(var.fallback.types, var.instance.types)) == 0
    error_message = "fallback.types must be a subset of instance.types."
  }
}

variable "alerts" {
  description = "Where alerts go. Secret fields are names under /<prefix>/shared/, never values."
  type = object({
    email               = optional(string)
    ntfy_secret         = optional(string)
    web_push            = optional(bool, true)
    webhook_secret      = optional(string)
    healthchecks_secret = optional(string)
  })
  default = {}

  validation {
    condition     = var.alerts.email == null ? true : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alerts.email))
    error_message = "alerts.email must be an email address."
  }
  validation {
    condition = alltrue([
      for s in [var.alerts.ntfy_secret, var.alerts.webhook_secret, var.alerts.healthchecks_secret] :
      s == null ? true : can(regex("^[a-z0-9-]{1,40}$", s))
    ])
    error_message = "alerts secret names must match ^[a-z0-9-]{1,40}$ (names under /<prefix>/shared/, not values)."
  }
}

variable "front_door_enabled" {
  description = "CloudFront with OAC and WAF in front of the control Function URL."
  type        = bool
  default     = true
}

variable "waf_rate_limit_per_5min" {
  description = "Requests per 5 minutes per client address before the WAF rate rule blocks."
  type        = number
  default     = 300

  validation {
    condition     = var.waf_rate_limit_per_5min >= 10 && var.waf_rate_limit_per_5min == floor(var.waf_rate_limit_per_5min)
    error_message = "waf_rate_limit_per_5min must be a whole number of at least 10."
  }
}

variable "wake_sources" {
  description = "Outside wake sources. Secrets are names under /<prefix>/shared/, never values."
  type = object({
    github  = optional(object({ enabled = bool, secret = string }))
    generic = optional(object({ enabled = bool, secret = string }))
  })
  default = {}

  validation {
    condition = alltrue([
      for s in [var.wake_sources.github, var.wake_sources.generic] :
      s == null ? true : can(regex("^[a-z0-9-]{1,40}$", s.secret))
    ])
    error_message = "wake_sources secret names must match ^[a-z0-9-]{1,40}$ (names under /<prefix>/shared/, not values)."
  }
}

variable "wake_budget" {
  description = "Most outside-event wakes per hour and per day."
  type = object({
    per_hour = optional(number, 6)
    per_day  = optional(number, 24)
  })
  default = {}

  validation {
    condition     = var.wake_budget.per_hour >= 1 && var.wake_budget.per_day >= var.wake_budget.per_hour
    error_message = "wake_budget.per_hour must be at least 1 and wake_budget.per_day at least per_hour."
  }
}

variable "payloads" {
  description = "Payload definitions by name (part 5 §5.5). The agent validates each at boot."
  # any, not map(any): map(any) forces every definition to one object type, so two payloads of different shapes fail.
  type = any

  validation {
    condition     = try(length(keys(var.payloads)) >= 1 && length(keys(var.payloads)) <= 4, false)
    error_message = "payloads must be a map of 1 to 4 payload definitions."
  }
  validation {
    condition     = try(alltrue([for n in keys(var.payloads) : can(regex("^[a-z][a-z0-9-]{0,30}$", n))]), false)
    error_message = "payload names must match ^[a-z][a-z0-9-]{0,30}$."
  }
}

variable "agent" {
  description = "Agent release. version = \"none\" renders user data that only logs and powers off (test stacks)."
  type = object({
    version           = string
    artifact_base_url = optional(string)
    sha256            = optional(map(string))
  })

  validation {
    condition     = var.agent.version == "none" || can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$", var.agent.version))
    error_message = "agent.version must be a semantic version such as 1.0.0, or none."
  }
  validation {
    condition     = var.agent.artifact_base_url == null ? true : startswith(var.agent.artifact_base_url, "https://")
    error_message = "agent.artifact_base_url must be an https URL."
  }
  validation {
    condition = var.agent.sha256 == null ? true : alltrue([
      for arch, sum in var.agent.sha256 : contains(["arm64", "x86_64"], arch) && can(regex("^[0-9a-f]{64}$", sum))
    ])
    error_message = "agent.sha256 maps arm64 or x86_64 to a 64-character lowercase hex SHA-256."
  }
}

variable "jail" {
  description = "Jail for agents the payload launches, and its egress mode."
  type = object({
    enabled     = optional(bool, true)
    egress      = optional(string, "imds-only")
    allow_hosts = optional(list(string), [])
  })
  default = {}

  validation {
    condition     = contains(["imds-only", "allowlist"], var.jail.egress)
    error_message = "jail.egress must be imds-only or allowlist."
  }
  validation {
    condition     = length(var.jail.allow_hosts) <= 64 && alltrue([for h in var.jail.allow_hosts : can(regex("^[A-Za-z0-9.*-]{1,253}$", h))])
    error_message = "jail.allow_hosts must list at most 64 host names."
  }
}

variable "tripwire_enabled" {
  description = "Decoy key and CloudTrail data path."
  type        = bool
  default     = true
}

variable "restore_test" {
  description = "Weekly restore test of the latest snapshot on a throwaway instance."
  type = object({
    enabled           = optional(bool, true)
    schedule          = optional(string, "cron(0 4 ? * SUN *)")
    close_after_hours = optional(number, 2)
  })
  default = {}

  validation {
    condition     = can(regex("^(cron|rate)\\(.+\\)$", var.restore_test.schedule))
    error_message = "restore_test.schedule must be a cron(...) or rate(...) expression."
  }
  validation {
    condition     = var.restore_test.close_after_hours >= 1 && var.restore_test.close_after_hours <= 24
    error_message = "restore_test.close_after_hours must be between 1 and 24."
  }
}

variable "fis_enabled" {
  description = "FIS templates for drills, with a stop condition on the cap alarm."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "Retention of every log group the module creates."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a CloudWatch Logs retention value (1, 3, 5, 7, 14, 30, 60, 90, ...)."
  }
}

variable "enable_ssm_session" {
  description = "Adds the scoped Session Manager policy to the instance role."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Added to every resource. The module adds <prefix>:box = <box_id>."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for k in keys(var.tags) : !startswith(lower(k), "aws:")])
    error_message = "tags keys must not start with aws: (reserved by AWS)."
  }
  validation {
    condition     = !contains(keys(var.tags), "${var.name_prefix}:box")
    error_message = "tags must not set <prefix>:box; the module sets it from box_id."
  }
}
