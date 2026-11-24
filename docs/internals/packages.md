# Packages

One job per package, a small public surface through `package.json` `exports`, and a fixed list of packages each may
import. `.dependency-cruiser.cjs` enforces the edges; `scripts/check-words.ts` enforces the words rule.

| Package                    | Job                                                                                                                  | May import                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `@dozebox/protocol`        | Types, TypeBox schemas, JSON Schema files for the payload protocol, records, control API, payload definition, config | `typebox`                                        |
| `@dozebox/client`          | Node client for payloads                                                                                             | `protocol`                                       |
| `@dozebox/core`            | Pure decision functions: idle, health, liveness, wake, reconcile, caps, alerts, summary, records, time               | `protocol`                                       |
| `@dozebox/agent`           | The box agent: a shell around `core` with Linux and AWS adapters                                                     | `protocol`, `core`                               |
| `@dozebox/control`         | The control function: Lambda handlers around `core` with AWS adapters                                                | `protocol`, `core`                               |
| `dozebox` (`packages/cli`) | The `dozebox` command                                                                                                | `protocol`, `client`, `core` (`summary`, `time`) |
| `@dozebox/sim`             | Simulator, invariants, known classes, judge                                                                          | `protocol`, `core`, `testkit`                    |
| `@dozebox/testkit`         | Fakes, contract suites, fixtures                                                                                     | `protocol`, `core`                               |

Traps:

- `core` has no I/O, no clock and no randomness. Time and randomness come in as arguments.
- `agent` and `control` never import each other.
- No package imports `sim` or `testkit` outside tests.
- Only files under `src/adapters/aws/` import `@aws-sdk/*`.
- Workspace packages export their TypeScript sources under the `@dozebox/source` condition, so tests and type checks
  run without a build. Published builds use the `types` and `default` conditions.
