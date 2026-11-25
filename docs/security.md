# Security

What Dozebox protects, what an attacker could try, and what you must do yourself. To report a vulnerability, see
[SECURITY.md](../SECURITY.md).

## What matters, in order

1. The money in the AWS account: a runaway instance or an On-Demand loop.
2. The credentials the payload uses. They act as you elsewhere.
3. The data volume: your code, history and databases.
4. Control of the box: wake, park, unfreeze.
5. The alert path. A silenced alert path hides every other failure.

## What bounds the damage

| Threat                                    | Control                                                                                                                         | State                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Someone wakes the box again and again     | A wake budget (`wake_budget`, default 6 an hour and 24 a day) and a breaker that pauses unattended wakes                        | Built                                                |
| A runaway box spends money                | Monthly budget with a freeze (`caps`), an awake-hours alarm and an On-Demand-hours alarm that freeze the box with a deny policy | Built                                                |
| A guessed or stolen wake token            | Constant-time compare, `dozebox token rotate`, no token in query strings, the wake budget                                       | Built                                                |
| The control URL called by anyone          | The Function URL requires SigV4 while `front_door_enabled` is `true`                                                            | Built                                                |
| Internet traffic flooding the control URL | A WAF rate rule behind CloudFront (`waf_rate_limit_per_5min`)                                                                   | Built (`front_door_enabled`)                         |
| A forged webhook                          | HMAC signature, constant-time compare, replay window for generic hooks                                                          | Built in the function; not enabled by the module yet |
| A prompt-injected agent reads credentials | A jail with no instance metadata and a decoy credential that pages when used (`jail`, `tripwire_enabled`)                       | Planned (the agent)                                  |
| Deleted data                              | Daily snapshots, a Recycle Bin rule, `destroy` snapshots every tagged volume first, `prevent_destroy`                           | Built                                                |
| A compromised dependency                  | A pinned lockfile, few dependencies, checksum-verified agent artifact                                                           | Built, release checks planned                        |

## The control API

- Tokens travel in `x-dozebox-token`. A wrong, missing or unconfigured token gets the same `401`, so a caller learns
  nothing about the box. Status holds no secrets, account ids or addresses.
- Admin actions (park without holds, restore, rebuild, operator hold) are IAM-only: `lambda:InvokeFunction` with your
  credentials. A leaked wake token cannot send them.
- Unfreeze is not available over HTTP. It needs a person's credentials through `dozebox unfreeze`, and the CLI
  refuses to run it as the box's own role.
- Every `5xx` is logged by name and code only, never the SDK message, which can embed ARNs.

## IAM

Each role (box, control function, operations) uses customer-managed policies of one concern each, kept under 5,500
characters (AWS allows 6,144). `terraform test` measures them, and `dozebox doctor` checks the `iam_policy_sizes` output.
The box can stop only instances tagged with its own box id and attach only the volume tagged active for its box. The control function never
deletes volumes or snapshots. Set `iam_permissions_boundary` if your account requires one on every role.

## Secrets

- Terraform never takes a secret value. Inputs take the name of a SecureString under `/<prefix>/shared/`.
- `dozebox secrets set` reads the value from standard input or a no-echo prompt, never from a flag.
- `stack.json` caches only non-sensitive outputs.
- `dozebox token show` and `dozebox phone pair` print links that carry a token in the URL fragment. Treat them like
  passwords, and do not paste them into chat or tickets.

## Your checklist

1. Set at least one alert channel, run `dozebox alerts test`, and confirm the email subscription. `dozebox doctor`
   fails while the path is broken.
2. Set `caps.monthly_budget_usd` to what you can lose. The kill switch is the backstop, not the plan.
3. Keep `front_door_enabled = true` unless you accept a public control URL protected only by the token.
4. Run `dozebox bootstrap` with an account you trust, and keep deploy credentials off the box.
5. Rotate the wake token with `dozebox token rotate` when a device is lost, and revoke a phone with
   `dozebox phone revoke <id>`.
6. Do not run a payload you do not trust in a box that holds credentials you cannot lose. The jail narrows what an
   agent can reach, but the payload itself runs with the box's role.
7. Check the restore. `dozebox doctor` reports the age and result of the weekly restore test.

## Reporting

Private reports go through GitHub's private vulnerability reporting. See [SECURITY.md](../SECURITY.md).
