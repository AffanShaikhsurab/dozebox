# Dozebox

Dozebox runs one program (a payload) on one AWS machine that sleeps when nobody needs it. The box wakes when you or
an event asks, keeps its data volume across sleeps, and stops everything when the budget breaks. You deploy it with
Terraform and operate it with the `dozebox` command.

Status: early development. The control function, the CLI, the Terraform module and the protocol packages work
against fakes and are being proven on real AWS. The box agent (`dozeboxd`), the front door (CloudFront and WAF) and
the published releases are planned. Each page below says what is built and what is planned.

## Quickstart

```bash
pnpm install                                  # in a checkout of this repository
alias dozebox='node --conditions=@dozebox/source packages/cli/src/bin.ts'
dozebox bootstrap --region us-east-1          # once per AWS account
mkdir .dozebox                                # write the stack's main.tf: see docs/quickstart.md
dozebox setup                                 # terraform apply, wake token, alert email, checks
dozebox wake --wait --until running           # start the box and wait for it
dozebox status
dozebox park                                  # sleep now
dozebox destroy                               # snapshot every volume, then remove the stack
```

Needs Node 24.12 or newer, pnpm 12, Terraform 1.9 or newer, the AWS CLI and AWS credentials.

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
