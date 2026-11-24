# Dozebox

Dozebox runs one program (a payload) on one AWS machine that sleeps when nobody needs it, wakes when someone or
something does, keeps its data across sleeps, and stops everything when the budget breaks.

Status: early development. Nothing here is ready to deploy yet.

## Develop

```bash
pnpm install
pnpm check      # format, lint, types, tests, schemas, sizes, unused code
pnpm tf:test    # Terraform tests with a mocked AWS provider
```

Node 24.12 or newer (CI uses Node 26), pnpm 12, Terraform 1.9 or newer.

- Contributing: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Security reports: [SECURITY.md](./SECURITY.md)
- Decisions: [docs/decisions](./docs/decisions)

## License

[MIT](./LICENSE)
