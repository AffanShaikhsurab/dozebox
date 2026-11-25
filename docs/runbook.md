# Runbook

One section per alert. Each says what it means, what to check and the command that fixes it. Start with
`dozebox status` and `dozebox doctor`: between them they show the box, the caps, the alert path and the last error.

In the commands below `<name>` is `<name_prefix>-<box_id>`, for example `dozebox-main`. The control function logs to
`/aws/lambda/<name>-control` in CloudWatch Logs, and `terraform -chdir=.dozebox output dashboard_url` prints the
dashboard.

Alerts come from three places: the control function (pages and notices through the alert topic), CloudWatch alarms
named `<name>-<alarm>`, and AWS Budgets. The agent on the box also raises alerts (disk full, payload crash loop, a spot reclaim); they start once an agent
release is deployed.

## The box did not wake

Alert: `The box did not wake` (page), and the alarm `<name>-wake-unresolved`.

Means: a wake was accepted more than 15 minutes ago and the payload is not serving. The breaker now counts it as a
failed wake, and after repeated failures it pauses unattended wakes.

Check:

1. `dozebox status`: the `state`, `Last error` and `Instance` lines. `waiting-capacity` means Spot has none.
2. `dozebox doctor`: quotas, the stack outputs, `frozen`.
3. The control function log, and for a started instance its console output in EC2.

Fix:

- `waiting-capacity` or `aws_capacity`: see [No capacity](#no-capacity-for-the-instance).
- A bad boot: `dozebox rebuild` replaces the instance and keeps the volume, then `dozebox wake --wait`.
- Frozen: [Kill switch](#kill-switch-the-box-is-frozen).

## The box is silent

Alert: `The box is silent` (page).

Means: the payload was serving, but the box has written no liveness record for 12 minutes. The instance may be
running with a dead agent, or the network may be down.

Check: `dozebox status` for `Serving since` and the instance state; the box log group `/<prefix>/<box_id>/box`.

Fix: `dozebox park --force`, then `dozebox wake --wait`. If it repeats, `dozebox rebuild`. A silent box that is still
running costs money, so do not leave it.

## Parked: no progress

Alert: `Parked: no progress` (notice).

Means: the box was awake but no payload reported progress, and no hold or person kept it, for too long. The box's own
limit is `no_progress_park_minutes` (default 150). The control function's outside judge uses 2 hours today. The control
function parked it.

Check: whether the payload is stuck. `dozebox status` shows `Last park`. The payload's own log is on the box.

Fix: nothing to repair if the work was done. If the payload should have worked, fix the payload's beats or holds
([Payloads](./payloads.md)) and `dozebox wake`. Raise `no_progress_park_minutes` only for a payload that works quietly.

## Budget freeze

Alert: `Budget freeze` (page).

Means: spend reached the monthly budget (`caps.monthly_budget_usd`) with `freeze_on_budget` on. The control function
wrote a freeze record and parks the box. Nothing wakes it until you unfreeze.

Check: `dozebox status` (`Caps` shows the spend), the Cost Explorer for what spent it, and `dozebox volumes list` for
volumes you forgot.

Fix: find the cause first. Then `dozebox unfreeze --reason "<why>"` and, if the budget was too low, raise
`caps.monthly_budget_usd` and `dozebox deploy`. A freeze that returns the next day means the cause is still there.

## Kill switch: the box is frozen

Alert: the CloudWatch alarm `<name>-kill-awake` or `<name>-kill-on-demand`.

Means: the box was awake (or on On-Demand) for nearly every hour of the last 24, past `caps.awake_hours_per_day` or
`caps.on_demand_hours_per_day` plus one hour. The kill runbook attached a deny policy to the box and control roles,
set the Auto Scaling groups to zero, stopped the instance and wrote a freeze record. The awake alarm exists only when
`awake_hours_per_day` is set.

Check: `dozebox status` shows `FROZEN`. Find out why the box ran so long: a payload that never idles, a hold that never
ends, a loop of wakes.

Fix: `dozebox unfreeze --reason "<why>"`. It runs the unfreeze runbook with your credentials: it detaches the deny
policy and clears the freeze record. It starts nothing; the next wake does. The command refuses to run as the box's
own role. If it says the stack has no `unfreeze_runbook` output, the module version predates that output.

## AWS Budgets: 80%, 100%, forecast

Alert: an email from AWS Budgets for the `<name>` budget.

Means: actual spend reached 80% or 100% of `monthly_budget_usd`, or AWS forecasts 100%. This is a warning from AWS, and
it covers the whole tagged box, including volumes and snapshots.

Check: `dozebox status` for the spend, `dozebox volumes list` and `dozebox snapshots list` for storage that grew.

Fix: park the box if it is awake (`dozebox park`), delete volumes and snapshots you no longer need
(`dozebox snapshots delete <id>`, `dozebox volumes retire <id>` then delete it in the console), or raise the budget.

## Control function quiet

Alert: the alarm `<name>-control-quiet`; it also sends an OK when the ticks resume.

Means: no reconcile tick completed or was skipped in 10 minutes. Nothing is waking, parking or judging the box.

Check: the log group `/aws/lambda/<name>-control`; the EventBridge Scheduler schedule for the box is enabled; the
function's dead-letter queue; `dozebox doctor` (`control` check).

Fix: a `deploy` of a bad bundle is the usual cause. Roll back with `control_bundle_path` set to the last good zip and
`dozebox deploy`. A box already awake still parks itself when idle, because the agent does not depend on this function.

## Alert path broken

Alert: the alarm `<name>-alert-path-broken` (a sink failed to deliver in the last hour), or `dozebox doctor` reporting
`alert-path` or `alert-email`.

Means: some alerts may not reach you. This is the most important alert to fix, because it hides the others.

Check: `dozebox alerts path` for the verdict and `dozebox alerts test` to send one. Look for an unconfirmed email
subscription: `doctor` prints `Confirm the alert email`.

Fix: confirm the email from AWS (`dozebox doctor --fix` asks AWS to resend it). For a webhook or ntfy sink, check the
secret named in `alerts` exists (`dozebox secrets list`) and the URL still works.

## Version skew

Alert: the alarm `<name>-version-skew`.

Means: the control function read a record with a schema version it does not know. The box and the function run
different releases.

Check: `dozebox status --releases` (needs admin events, which are planned: [issue 2](https://github.com/AffanShaikhsurab/dozebox/issues/2)) or the agent version in the stack
(`agent.version`) against the control bundle you deployed.

Fix: bring both to one release: `dozebox upgrade --agent <version>` and `dozebox deploy` the matching control bundle.
A reader treats an unknown record as missing; it never guesses, so the box keeps running, but decisions that need the
record wait.

## Runner bug

Alert: the alarm `<name>-runner-bug`.

Means: the runner reached a state it should never reach. It logged the route and the error name.

Check: the control function log for `error` lines, and `dozebox status`.

Fix: `dozebox status`, then `dozebox wake` or `dozebox park` to see whether the box still obeys. Report the log lines
at the project's issue tracker (never with tokens in them). A `rebuild` does not fix a bug in the control function.

## No capacity for the instance

Alert: `dozebox status` shows `waiting-capacity` or `stopped-error` with `aws_capacity`, and the wake alert follows.

Means: EC2 has no capacity for the instance types in this zone. The data volume lives in one zone, so the box cannot
simply start elsewhere.

Check: `dozebox status`; `dozebox volumes list` shows the volume's zone.

Fix: add instance types to `instance.types` and `dozebox deploy`. If the zone stays full, `dozebox move-az <az>` parks the
box, snapshots the volume, creates a new one in the other zone and retires the old one. See
[Operations](./operations.md#move-the-volume-to-another-zone).

## Restore test failed

Alert: `dozebox doctor` fails `restore-test` (`last restore test: <result>`).

Means: the weekly job that restores the latest snapshot on a throwaway instance did not succeed. Your backups may not
restore.

Check: `dozebox snapshots list`; the state of the newest snapshot; the restore test's logs.

Fix: `dozebox snapshots create --label manual`, then repeat the test. Do not rely on the backups until it passes.

## Test an alert

`dozebox alerts test --severity page` sends one alert through the alert topic. You get at most one a minute. Do it after
every change to `alerts`.
