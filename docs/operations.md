# Operations

Routine work on a running box: upgrades, backups and restores, moving to another zone, replacing the instance and
adopting an old stack. For alerts, see the [runbook](./runbook.md).

Several of these commands (`restore`, `move-az`, `rebuild`, `park`, `status --records`) act through admin events that
the control function does not serve yet ([issue 16](https://github.com/AffanShaikhsurab/dozebox/issues/16)). They work against the CLI's fakes and fail against a real stack until that
lands. Each section says so.

## Upgrades

**The agent.** `dozebox upgrade --agent <version>` records the version in `<stack>/dozebox.auto.tfvars.json` and applies
it. Terraform loads that file on every plan, so a later `deploy` keeps the version. Your stack root must declare
`variable "agent_version"` and pass it as `agent = { version = var.agent_version }` (`examples/drill` does). The box
picks the new agent up at its next boot. The agent is built, but its release artifact and rollback are planned; today `version = "none"` is the only
agent a stack can boot.

**The control function.** Build the bundle and deploy it:

```bash
pnpm --filter @dozebox/control build
dozebox deploy
```

The zip is deterministic, so Terraform redeploys the function only when its code changes. To roll back, point
`control_bundle_path` at the previous zip and deploy.

**The module.** Update the `source` (a path to your checkout, or a tag when releases exist), then `dozebox setup
--plan-only` to read the plan before `dozebox deploy`. A change that would replace the data volume has
`prevent_destroy` and fails the plan; stop and ask before you work around it.

**Compatibility.** Records, the control API, payload definitions and config carry a version. A reader that meets a newer
record treats it as missing, and the `version-skew` alarm tells you. Keep the agent and the control function on the
same release. See [Versioning](./protocol/v1.md#versioning).

## Snapshots and restores

The module takes a snapshot of the data volume every `snapshots.every_hours` (24) and keeps `snapshots.keep` (7).
Deleted snapshots stay in the Recycle Bin for `snapshots.recycle_bin_days` (7). A weekly restore test proves the latest
one restores (`restore_test`).

```bash
dozebox snapshots list
dozebox snapshots create --label before-upgrade
dozebox snapshots delete snap-0123456789abcdef0
```

`snapshots create` waits until the snapshot is `completed`; add `--no-wait` to return at once.

**Restore.**

```bash
dozebox restore latest
dozebox restore snap-0123456789abcdef0 --az us-east-1b
```

`restore` parks the box, creates a volume from the snapshot, tags it `active` and keeps the old volume tagged
`retired` for `snapshots.retired_volume_days` (14). The zone defaults to the current volume's, because the launch
template and subnet already point there. A different `--az` is a move and says so. Planned:
estore needs the admin
`swap-volume` event ([issue 16](https://github.com/AffanShaikhsurab/dozebox/issues/16)). The control function's volume port, the fallback volume hand-off and the weekly restore
test are also planned ([issue 17](https://github.com/AffanShaikhsurab/dozebox/issues/17)).

`dozebox volumes list` shows every volume tagged to the box with its zone and state, and flags a box with no active
volume (exit code 1). `dozebox volumes retire <id>` tags a volume retired (never the active one). Retired volumes cost
money until you delete them.

**Destroy.** `dozebox destroy` snapshots every tagged volume, active or not, then runs `terraform destroy`. Use
`--no-keep-snapshots` only when you mean to lose the data.

## Move the volume to another zone

For a zone that has no capacity for your instance types:

```bash
dozebox move-az us-east-1b
```

It parks the box, snapshots the volume, creates a new volume from that snapshot in the target zone, makes it active
inside the control function's lease and retires the old one. The subnet and the launch template must cover the target
zone, so list subnets in both zones in `network.subnet_ids` first. Planned: it uses the admin `swap-volume` event ([issue 16](https://github.com/AffanShaikhsurab/dozebox/issues/16)).

## Replace the instance

`dozebox rebuild` gives the box a new instance (a new launch template version, a fresh root disk and first boot) at the
next wake and keeps the data volume. Use it when the root disk or the boot is the problem. Planned: it uses the admin
`rebuild` event ([issue 16](https://github.com/AffanShaikhsurab/dozebox/issues/16)).

## Change the payload

Edit the definition and `dozebox deploy`. Terraform writes it to SSM. The agent reads payload definitions at boot and
applies a change at the next payload restart. See [Payloads](./payloads.md).

## Legacy names

A stack built by the old runner keeps its resource names, SSM paths and tag prefix, so adopting the module renames and
replaces as little as possible ([decision 0009](./decisions/0009-name-prefix.md)). The old stack used the prefix
`t3box`. `examples/legacy-t3box` is a stack root that does this.

1. In the adopting stack set the old prefix in four inputs:

   ```hcl
   name_prefix = "t3box"
   box_id      = "main"
   ssm_prefix  = "/t3box/main/"
   tag_prefix  = "t3box"
   ```

   `name_prefix` and `box_id` give the resource names. `ssm_prefix` gives the SSM paths and the box log group, and
   `tag_prefix` gives the tag keys. Without the two overrides both follow `name_prefix`.

2. Copy the old state to the new root's backend (`terraform state pull`, then point the backend key at the new root).
3. Generate the `moved` and `removed` blocks from the old root's resource list:

   ```bash
   terraform state list | node scripts/gen-moved.ts > moved.tf
   ```

   Add `--module <name>` if your module block is not called `dozebox`. A `moved` block maps an old address to its
   address inside the module. A `removed` block forgets a resource the module does not own, with `destroy = false`, so
   it stays in AWS until you delete it. The script exits with an error and lists every address it has no rule for.

4. Run `terraform plan` and read every replacement before you apply.

**Tags.** The module keeps its `<prefix>:box` tag key. The old stack tagged with `t3box:id`. Tags change in place on
AWS, so the first apply retags the adopted resources instead of replacing them.

**Names the prefixes do not reproduce.** These are created new with the module's names:

| Resource            | Old name                   | Module name          |
| ------------------- | -------------------------- | -------------------- |
| Instance role       | `<name>-instance`          | `<name>-box`         |
| Snapshot (DLM) role | `<name>-dlm`               | `<name>-snapshots`   |
| Dead-letter queue   | `<name>-control-failed`    | `<name>-control-dlq` |
| Launch template     | one per group              | one, named `<name>`  |
| Freeze record       | `<ssm_prefix>spend-freeze` | `<ssm_prefix>freeze` |

`<name>` is `<name_prefix>-<box_id>`. A resource whose name changes is replaced, not renamed. The `removed` blocks leave
the old roles' inline policies attached, and AWS will not delete a role that still has inline policies. Delete those
policies first (`aws iam delete-role-policy`), or the replacement fails.
