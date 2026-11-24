# Dozebox: agent guide

Dozebox runs one payload on one AWS machine that sleeps when idle. Read `docs/concepts.md` for the words.
Facts here were verified at the phase 0 skeleton on 2026-11-25. If one is wrong, fix this file in the same change.

## Rules that can't bend

1. Tests never call real AWS. Fakes refuse non-loopback endpoints. Drills are manual (`.github/workflows/aws-drills.yml`).
2. The runner knows no payload. No payload name outside `examples/` (checked by `pnpm lint`).
3. `packages/core` is pure: no I/O, no clock, no randomness. Pass them in.
4. A change to a decision in `core` (idle, health, wake, reconcile, caps, alert policy) ships with a test row
   and a `pnpm sim` run. Paste the census line in the PR.
5. Every public interface change (protocol, records, control API, CLI, Terraform, config) follows
   `docs/protocol/v1.md#versioning`. Breaking means a major.
6. Never force-detach a volume, never delete a snapshot or volume in code without a test that proves the
   snapshot of every tagged volume ran first.
7. No PR unless the person asked for one.

## Change X, edit Y

| Change                        | Edit                                                                               | Test                                               |
| ----------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------- |
| A protocol field or endpoint  | `packages/protocol/src/v1/*.ts`, then `pnpm --filter @dozebox/protocol gen:schema` | protocol + `testkit/contracts/protocol*`           |
| When the box sleeps           | `packages/core/src/idle/`                                                          | `core/test/idle.test.ts`, `pnpm sim`               |
| Restart or park on bad health | `packages/core/src/health/`                                                        | `core/test/health.test.ts`                         |
| Wake, fallback, hand-off      | `packages/core/src/reconcile/`, `packages/control/src/reconcile/act.ts`            | `core/test/reconcile.test.ts`, `pnpm sim`          |
| A new alert sink              | `packages/control/src/alerts/sinks/<name>.ts` + `plugins.ts`                       | `testkit/contracts/alertSink.ts`                   |
| A new wake source             | `packages/control/src/wake/sources/<name>.ts`                                      | `testkit/contracts/wakeSource.ts`                  |
| A CLI command                 | `packages/cli/src/commands/<name>.ts`                                              | `cli/test/<name>.test.ts`                          |
| An AWS resource or IAM        | `terraform/*.tf`                                                                   | `terraform/tests/*.tftest.hcl`, `pnpm check:sizes` |
| Boot before Node              | `box/stage0/*.sh` (< 100 lines each)                                               | `shellcheck`, `box/test/`                          |

## Checks

`pnpm check` before you say done. One package: `pnpm --filter <pkg> test`. Terraform: `pnpm tf:test`.
"It compiles" is not evidence. Say what you ran and what it printed.

## Where to look first

Each package has its own AGENTS.md. Package boundaries: `docs/internals/packages.md`. `legacy/` is the old runner,
kept for reference and for the simulator judge; never import from it.
