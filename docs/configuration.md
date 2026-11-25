# Configuration

You configure a box with the inputs of the Terraform module in `terraform/`. Objects take `optional(...)` fields, so
set only what you need. `examples/minimal` is the smallest working stack and `examples/drill` is the test-account
stack. Every input, type, default and rule is in the generated [Terraform reference](./reference/terraform.md); this
page groups them by what you want to do.

Secrets are never inputs. A field that ends in `secret` takes the name of a SecureString under `/<prefix>/shared/`.
Create it with `dozebox secrets set <name>`.

After you change an input, run `dozebox deploy`. The box picks up most settings within 5 minutes. Payload definitions
apply at the next payload restart.

## Required

| Input         | Example                                                 | Notes                                                                                           |
| ------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `instance`    | `{ types = ["t4g.medium", "t4g.large"] }`               | 1 to 10 types, the first preferred. `arch` is `arm64` unless you set it.                        |
| `data_volume` | `{ size_gb = 100 }`                                     | 20 to 4096 GiB, encrypted. Holds all payload state.                                             |
| `caps`        | `{ monthly_budget_usd = 60 }`                           | See [Spending limits](#spending-limits).                                                        |
| `payloads`    | `{ app = jsondecode(file("${path.module}/app.json")) }` | 1 to 4 [payload definitions](./payloads.md).                                                    |
| `agent`       | `{ version = "none" }`                                  | `none` boots, logs and powers off, for test stacks. The agent is built; its release is planned. |

## Names

| Input         | Default   | Meaning                                                                |
| ------------- | --------- | ---------------------------------------------------------------------- |
| `box_id`      | `main`    | The box's id in names, SSM paths and tags. One stack per box.          |
| `name_prefix` | `dozebox` | Prefix of every resource name, SSM path and tag key.                   |
| `ssm_prefix`  | `null`    | Overrides the SSM path, such as `/legacy/main/`, for an adopted stack. |
| `tag_prefix`  | `null`    | Overrides the tag key prefix (`<prefix>:box`), for an adopted stack.   |
| `tags`        | `{}`      | Added to every resource. The module adds `<prefix>:box`.               |

`ssm_prefix` and `tag_prefix` exist so an old stack can keep its names ([decision 0009](./decisions/0009-name-prefix.md),
[Operations](./operations.md#legacy-names)). Without them both follow `name_prefix`.

## When the box sleeps

| Input                      | Default | Meaning                                                                        |
| -------------------------- | ------- | ------------------------------------------------------------------------------ |
| `idle_minutes`             | 30      | Minutes with no hold, presence or activity before the box parks (5 to 720).    |
| `no_progress_park_minutes` | 150     | Minutes without a progress beat before it parks even with a hold (30 to 1440). |

## Spending limits

`caps` has three limits and a switch:

| Field                     | Default  | Meaning                                                                        |
| ------------------------- | -------- | ------------------------------------------------------------------------------ |
| `monthly_budget_usd`      | required | An AWS Budget alerts at 80% and 100% of this, and at a forecast of 100%.       |
| `awake_hours_per_day`     | none     | The box stops waking for the rest of the day once it has been awake this long. |
| `on_demand_hours_per_day` | 3        | The most On-Demand (fallback) hours a day.                                     |
| `max_spot_price_per_hour` | none     | The highest Spot price you will pay.                                           |
| `freeze_on_budget`        | `true`   | Freeze the box when the budget is reached. `dozebox unfreeze` lifts it.        |

The kill switch is separate: a CloudWatch alarm on awake or On-Demand hours freezes the box by attaching a deny
policy. See the [runbook](./runbook.md#kill-switch-the-box-is-frozen).

`fallback` controls On-Demand: `enabled` (default `true`), `types` (a subset of `instance.types`), and `unattended`
(default `false`: scheduled and event wakes may not use On-Demand, only a person's wake may).

## Alerts

`alerts` takes `email`, `ntfy_secret`, `webhook_secret`, `healthchecks_secret` and `web_push`. Set at least one, then
run `dozebox alerts test`. An email address must be confirmed through the link AWS sends.

Built today: email through the SNS alert topic, which also carries CloudWatch alarms and AWS Budgets. The ntfy,
Web Push and webhook sinks exist in the control function, but the module does not pass `ntfy_secret`, `webhook_secret`
or `web_push` to it yet (planned), so only email reaches you. `doctor` reports an alert path that cannot reach you.

## Outside wakes

`wake_sources` enables `github` and `generic` webhooks, each with a `secret` name. `wake_budget` limits accepted
wakes (`per_hour` default 6, `per_day` default 24). Built today: the budget, and the hook routes in the control
function. Planned: the module does not pass `wake_sources` to the function yet, so no hook source is active. See the
[control API](./control-api.md#webhooks).

## Front door

| Input                     | Default | Meaning                                                                        |
| ------------------------- | ------- | ------------------------------------------------------------------------------ |
| `front_door_enabled`      | `true`  | CloudFront with a WAF in front of the control Function URL.                    |
| `waf_rate_limit_per_5min` | 300     | Requests per 5 minutes per client address before the WAF blocks (at least 10). |

With `front_door_enabled = true` the module builds a CloudFront distribution with origin access control in front of the
Function URL (which then needs `AWS_IAM`), forwards only `x-dozebox-token` and `x-t3box-token`, caches nothing, and puts
a WAF web ACL with a rate rule of `waf_rate_limit_per_5min` requests per client address in front of it. With `false`
the Function URL is public and token-checked.

## Machine and network

`instance.machine_mode` is `persistent` (one Spot instance, the default) or `group`. `network` creates a VPC unless
you give `vpc_id` and `subnet_ids`; no inbound rule exists unless you list `ssh_cidrs`. `enable_ssm_session` adds
Session Manager access to the instance role. `jail` sets whether payload-launched agents run in the jail and their
egress (`imds-only` or `allowlist`).

## Backups

`snapshots` sets the interval (`every_hours`, default 24), how many to keep (`keep`, 7), how long deleted snapshots stay
recoverable (`recycle_bin_days`, 7) and how long a retired volume is kept (`retired_volume_days`, 14).
`restore_test` runs a weekly restore of the latest snapshot on a throwaway instance. See
[Operations](./operations.md#snapshots-and-restores).

## Other

`tripwire_enabled` plants a decoy credential and watches for its use. `fis_enabled` adds fault-injection templates for
drills. `log_retention_days` (30) applies to every log group. `drill_mode` lets a test stack delete its data volume;
never set it on a stack with data. `iam_permissions_boundary` sets a boundary on every role the module creates.
`control_bundle_path` points at the control function's zip (`pnpm --filter @dozebox/control build` writes
`packages/control/dist/control.zip`).

## Outputs the CLI reads

The CLI reads a stack's outputs with `terraform output -json` and caches them in `<stack>/stack.json`. The required
ones are `box_id`, `region`, `control_url`, `control_function_name`, `ssm_prefix`, `wake_token_parameter`,
`alert_topic_arn` and `state_table_name`. Your stack root must re-export them from the module, as the
[quickstart](./quickstart.md#3-write-the-stack) shows.
