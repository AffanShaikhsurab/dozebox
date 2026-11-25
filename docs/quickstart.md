# Quickstart

From nothing to a box that sleeps, wakes on request and goes away again. It uses the test agent (`version = "none"`),
which boots, logs and powers off, so you see the whole wake and park cycle and the bill without running a payload.
The box agent that runs a real payload is planned.

You need an AWS account you may spend in, Node 24.12 or newer, pnpm 12, Terraform 1.9 or newer, the AWS CLI, and
credentials for the account (`aws sts get-caller-identity` works). The stack in this guide costs a few cents a day
while parked, mostly the data volume. See [Cost](./cost.md).

## 1. Get the CLI

The CLI is not published yet. Run it from a checkout:

```bash
git clone https://github.com/AffanShaikhsurab/dozebox.git && cd dozebox
pnpm install
pnpm --filter @dozebox/control build   # writes packages/control/dist/control.zip, the control function
alias dozebox='node --conditions=@dozebox/source packages/cli/src/bin.ts'
```

The alias is for the current shell. Every `dozebox` command below uses it. `dozebox help` lists the commands and
`dozebox help <command>` shows one command's flags. The full list is in the [CLI reference](./reference/cli.md).

## 2. Bootstrap the account

Bootstrap creates the Terraform state bucket and the policies for the principal that deploys, and activates the
`dozebox:box` cost allocation tag. Run it once per account and region.

```bash
dozebox bootstrap --region us-east-1
```

AWS knows a tag only after a resource uses it, so the cost tag may report "pending". Run bootstrap again after the
first deploy.

## 3. Write the stack

The stack directory is `./.dozebox` (change it with `--stack <dir>`). It holds a Terraform root that calls the module.
The CLI reads the root's outputs, so the root must re-export the module's outputs.

```bash
mkdir .dozebox
cp examples/payloads/marker.json .dozebox/marker.json
```

Create `.dozebox/main.tf`:

```hcl
terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.0, < 7.0" }
  }
}

provider "aws" {
  region = "us-east-1"
}

module "dozebox" {
  source = "../terraform" # the module in your checkout; a tagged Git source is planned

  instance            = { types = ["t4g.medium", "t4g.large"] }
  data_volume         = { size_gb = 50 }
  caps                = { monthly_budget_usd = 30 }
  alerts              = { email = "you@example.com" }
  payloads            = { marker = jsondecode(file("${path.module}/marker.json")) }
  agent               = { version = "none" }
  control_bundle_path = "${path.module}/../packages/control/dist/control.zip"
}

output "box_id" { value = module.dozebox.box_id }
output "region" { value = module.dozebox.region }
output "control_url" { value = module.dozebox.control_url }
output "control_function_name" { value = module.dozebox.control_function_name }
output "ssm_prefix" { value = module.dozebox.ssm_prefix }
output "wake_token_parameter" { value = module.dozebox.wake_token_parameter }
output "alert_topic_arn" { value = module.dozebox.alert_topic_arn }
output "state_table_name" { value = module.dozebox.state_table_name }
output "data_volume_id" { value = module.dozebox.data_volume_id }
output "instance_role_arn" { value = module.dozebox.instance_role_arn }
output "iam_policy_sizes" { value = module.dozebox.iam_policy_sizes }
```

The first eight outputs are required: a command that finds one missing stops with exit code 3 and names it. The
module's inputs are in [Configuration](./configuration.md). Leave out `control_bundle_path` and the control function
is a placeholder that answers 503 `not_deployed`.

## 4. Set up

`setup` runs `terraform init` and `apply`, stores the wake token, reports the alert email that still needs
confirming, and runs `doctor`. It is safe to run again: a step that is already done changes nothing.

```bash
dozebox setup
```

Open the confirmation email AWS sent to your alert address (check spam). Until you confirm it, an alert reaches no
one, and `doctor` reports it. Later changes to the stack go through `deploy`, which plans and applies only when the
plan has changes:

```bash
dozebox deploy
```

## 5. Look at the box

```bash
dozebox status
```

A new box is `parked`. `status` also prints the spend against the budget and whether alerts can reach you. `--json`
prints the same data as one JSON document.

## 6. Wake it

```bash
dozebox wake --wait --until running
```

This asks the control function to start the box and waits until the machine runs (up to 900 seconds, set with
`--timeout`). With the test agent the box never reports `serving`, so wait for `running`. With a real agent, plain
`--wait` waits until the payload serves. If the wake budget is used up the command exits with code 75 and says when
to retry. If the box is frozen it exits with code 5: see the [runbook](./runbook.md).

## 7. Park it

```bash
dozebox park
```

A real box parks itself after `idle_minutes` with no activity. `park` asks for it now, and `park --force` ignores
holds. Planned: the control function does not serve the admin events `park` uses yet, so today the command fails
against a real stack. `POST /v1/park` does the same over HTTP, see the [control API](./control-api.md).

## 8. Remove it

```bash
dozebox destroy
```

`destroy` parks the box, snapshots every volume tagged to it, waits for the snapshots, then runs `terraform destroy`.
It asks first. Snapshots and any volume Terraform does not own survive, and the command lists them. Delete them when
you are sure, or you keep paying for them.

## Next

- Run a real program: [Payloads](./payloads.md).
- Learn what each alert means: [Runbook](./runbook.md).
- Check this guide: `pnpm docs:check` runs every command above against fakes.
