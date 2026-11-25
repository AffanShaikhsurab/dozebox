# Dozebox

Dozebox runs one program (a payload) on one AWS machine that sleeps when nobody needs it. The box wakes when you or
an event asks, keeps its data volume across sleeps, and stops everything when the budget breaks. You deploy it with
Terraform and operate it with the `dozebox` command.

Status: early development. The control function, the CLI, the Terraform module and the protocol packages work
against fakes and are being proven on real AWS. The box agent (`dozeboxd`) and the front door (CloudFront and WAF) are built too. The agent's release artifact
and the published releases are planned. Each page below says what is built and what is planned.

## Quickstart

From an empty AWS account to a box that wakes, runs the `marker` test payload and sleeps again. Everything you need is
on this page. [docs/quickstart.md](./docs/quickstart.md) is the longer version.

### Before you start

- Node 24.12 or newer, Terraform 1.9 or newer, and the AWS CLI. The checkout path below also needs pnpm 12.
- AWS credentials for an account you may spend in. `aws sts get-caller-identity` must work. Bootstrap and the first
  deploy create IAM roles and policies, S3, DynamoDB, Lambda, EC2 and EBS resources, SNS and CloudWatch. Use an
  administrator for these two steps; `bootstrap` then creates policies for a narrower deploy principal.
- An email address for alerts. The stack costs a few cents a day while parked, mostly the data volume.

### 1. Install the CLI

The CLI is not on npm yet. Until it is, run it from a checkout:

```bash
git clone https://github.com/AffanShaikhsurab/dozebox.git && cd dozebox
pnpm install
pnpm --filter @dozebox/control build   # writes packages/control/dist/control.zip, the control function
alias dozebox='node --conditions=@dozebox/source packages/cli/src/bin.ts'
export TF_VAR_control_bundle="$PWD/packages/control/dist/control.zip"
```

Run every command below from this checkout. Once the CLI is published, install it instead with
`npm install -g dozebox`; the `dozebox` commands are the same.

### 2. Bootstrap the account

Creates the Terraform state bucket and the deploy policies. Run it once per account and region.

```bash
dozebox bootstrap --region us-east-1
```

### 3. Write the stack

Copy the `marker` test payload from the checkout:

```bash
mkdir .dozebox
cp examples/payloads/marker.json .dozebox/marker.json
```

Save the stack as `.dozebox/main.tf`. Replace the email address. The CLI reads the outputs, so keep all of them.

```hcl
terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.0, < 7.0" }
  }
}

variable "control_bundle" {
  type    = string
  default = null
}

provider "aws" {
  region = "us-east-1"
}

module "dozebox" {
  source = "git::https://github.com/AffanShaikhsurab/dozebox.git//terraform?ref=v0.9.0"

  instance            = { types = ["t4g.medium", "t4g.large"] }
  data_volume         = { size_gb = 50 }
  caps                = { monthly_budget_usd = 30 }
  alerts              = { email = "you@example.com" }
  payloads            = { marker = jsondecode(file("${path.module}/marker.json")) }
  agent               = { version = "none" }
  control_bundle_path = var.control_bundle
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

### 4. Set up, wake, check, park

```bash
dozebox setup                                 # terraform apply, wake token, alert email, checks
dozebox wake --wait --until running           # start the box and wait for the machine
dozebox status                                # state, instance, spend against the budget
dozebox park                                  # sleep now
```

Known problem ([issue 16](https://github.com/AffanShaikhsurab/dozebox/issues/16)): `park` fails against a real stack
today. The box still parks itself after its idle time, and `destroy` below parks it first.

Open the confirmation email AWS sends to your alert address (check spam). Until you confirm it, alerts reach no one.

`status` reports `running` with an instance line once the box is up. The `marker` payload serves `/health` inside the
box on 127.0.0.1:8080, not on the internet. A box with the real agent (`agent = { version = "1.0.0" }`) shows
`Serving since <time>` in `status` once `/health` answers 200, and `dozebox wake --wait` returns at that point. This
stack uses `version = "none"`, the test agent, which boots, logs and powers off, so `status` never shows
`Serving since`. The agent release is not published yet.

### 5. Remove it

```bash
dozebox destroy                               # snapshot every volume, then remove the stack
```

`destroy` asks first. Snapshots and the state bucket from bootstrap survive and cost a little until you delete them.

## Documentation

- [Quickstart](./docs/quickstart.md): from zero to a sleeping box
- [Concepts](./docs/concepts.md): the words
- [Payloads](./docs/payloads.md): define a payload, health-only or protocol mode, the client library
- [Configuration](./docs/configuration.md): the Terraform inputs by task
- [Control API](./docs/control-api.md): routes, tokens, status codes
- [Payload protocol v1](./docs/protocol/v1.md)
- [Security](./docs/security.md)
- [Runbook](./docs/runbook.md): what to do when an alert arrives
- [Operations](./docs/operations.md): upgrades, snapshots, moving a volume, legacy names
- [Cost](./docs/cost.md)
- Reference, generated: [CLI](./docs/reference/cli.md), [Terraform](./docs/reference/terraform.md),
  [protocol](./docs/reference/protocol-v1.md)
- [Decisions](./docs/decisions)

## Develop

```bash
pnpm install
pnpm check        # format, lint, types, tests, schemas, sizes, unused code
pnpm tf:test      # Terraform tests with a mocked AWS provider
pnpm docs:check   # links, generated reference tables, the quickstart against fakes
```

- Contributing: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Security reports: [SECURITY.md](./SECURITY.md)

## License

[MIT](./LICENSE)
