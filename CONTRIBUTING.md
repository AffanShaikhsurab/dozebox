# Contributing

## Dev loop

```bash
pnpm install
pnpm check
pnpm tf:test
```

`pnpm check` runs formatting, oxlint, dependency-cruiser, the words check, type checks, every package's tests, the
JSON Schema drift check, the size budgets and knip. CI runs the same, plus Terraform tests and gitleaks.

## Rules

- **One problem per PR.** A PR that fixes two things is two PRs.
- **Tests first** for behaviour that can break. Tests use `node --test` and sit in the package's `test/` folder,
  named after the module.
- **Tests never call real AWS.** The fakes in `@dozebox/testkit` refuse non-loopback endpoints. Real-AWS checks are
  drills, run by hand in your own account (`.github/workflows/aws-drills.yml`, or `scripts/aws-exit/*.sh`).
- **Decisions in `core` ship with a simulator run.** A change to idle, health, wake, reconcile, caps or alert policy
  adds a test row and pastes the `pnpm sim` census line in the PR.
- **Public interfaces are versioned.** Protocol, records, control API, CLI, Terraform inputs and outputs, config and
  the payload definition follow semver. Breaking means a major.
- **No payload names under `packages/`.** Examples live in `examples/`.

## Running drills in your account

Drills create real resources and cost money. Every drill tags what it creates, tears it down at the end, and prints
the estimated cost. Read `docs/operations/drills.md` (coming with the drill framework) before running one.
