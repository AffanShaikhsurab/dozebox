# Cost

What a box costs and how to keep it bounded. All numbers are estimates for `us-east-1`. The drill figures come from the
project plan, not from a measured run: no drill report exists yet. Replace them with the reports' totals when `dozebox
drill` writes them. Check AWS's pricing pages before you rely on any figure.

## What a parked box costs

A parked box has no instance. You pay for what stays:

| Item                                                 | Roughly                                  | Notes                                                            |
| ---------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| Data volume (gp3)                                    | $0.08 per GiB-month, so $4 for 50 GiB    | The biggest line on a parked box. `data_volume.size_gb` sets it. |
| Snapshots                                            | $0.05 per GiB-month of stored changes    | `snapshots.keep` and `every_hours` set how many.                 |
| CloudWatch alarms                                    | $0.10 per alarm per month, about a dozen | Signal, kill-switch and quiet alarms.                            |
| Control function, schedule, DynamoDB, SSM, SNS email | Under the free tier or a few cents       | One scheduled tick a minute is about 43,000 invocations a month. |
| Logs                                                 | Pennies at low volume                    | `log_retention_days` bounds it.                                  |

Planned: with the front door on, CloudFront and a WAF web ACL add about $5 to $7 a month (the ACL, one rule, requests).

## What an awake box costs

An awake box adds the instance for the hours it runs, plus about $0.005 an hour for its public IPv4 address. Spot is
usually a fraction of the On-Demand price, and the On-Demand fallback costs the full price, which is why
`caps.on_demand_hours_per_day` defaults to 3.

| Type         | On-Demand, about | Notes                               |
| ------------ | ---------------- | ----------------------------------- |
| `t4g.medium` | $0.034 per hour  | The test-account type.              |
| `t4g.large`  | $0.067 per hour  |                                     |
| `m7g.xlarge` | $0.163 per hour  | A working box; Spot is far cheaper. |

A box awake 8 hours a day on `m7g.xlarge` at the On-Demand price costs about $39 a month. On Spot it costs a fraction
of that.

## What bounds it

- `caps.monthly_budget_usd`: an AWS Budget warns at 80% and 100% and on a forecast of 100%, and the box freezes at the
  budget when `freeze_on_budget` is on.
- `caps.awake_hours_per_day` and `caps.on_demand_hours_per_day`: the control function stops waking the box past them, and
  the kill-switch alarms freeze it if it runs on regardless.
- `caps.max_spot_price_per_hour`: the highest Spot price you accept.
- `idle_minutes` and `no_progress_park_minutes`: how soon an idle box parks.
- The wake budget (`wake_budget`): at most 6 wakes an hour and 24 a day by default.

`dozebox status` prints the awake hours and the spend against these caps. The AWS Budget sees the whole tagged box, so it
includes volumes and snapshots. Activate the `dozebox:box` cost allocation tag (`dozebox bootstrap` does) so Cost
Explorer can split the box out.

## Drills

Drills run on real AWS in a test account, tear down after themselves and are meant to cost cents. The figures below are
the plan's estimates; each drill refuses to start above 60% of the account's monthly cap.

| Drill or check                                         | Estimated cost | Budget |
| ------------------------------------------------------ | -------------- | ------ |
| Apply a parked stack, check, destroy (phase 1)         | $0.05          | $0.25  |
| Wake and park a bare instance over HTTP (phase 2)      | $0.05          | $0.25  |
| `drill smoke` (wake, serve, sleep, restore, destroy)   | $0.10          | $0.50  |
| `drill spot` (Spot reclaim with a hold)                | $0.05          | n/a    |
| `drill fallback` (On-Demand when Spot has no capacity) | $0.10          | n/a    |
| `drill front-door`                                     | $0.05          | n/a    |
| `drill restore`                                        | $0.05          | n/a    |
| `drill kill` (freeze and unfreeze)                     | $0.05          | n/a    |
| Smoke with jail, tripwire and agent rollback           | $0.15          | $1.00  |
| The quickstart in a clean account                      | $0.20          | $1.00  |

One pass through every phase's exit test is about $1.50 against a budget of $8.50. The `drill` command exists in the CLI
and lists these drills; their steps are planned, so none has run yet.

## Cleaning up

Money leaks from what is left behind, not from the box. After `dozebox destroy`, list what remains: retired volumes
(`dozebox volumes list`), snapshots (`dozebox snapshots list`) and Terraform's state bucket. `destroy` lists the volumes
Terraform does not own, because they survive it.
