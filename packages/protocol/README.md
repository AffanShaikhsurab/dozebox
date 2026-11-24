# @dozebox/protocol

TypeBox schemas, TypeScript types and JSON Schema files for the dozebox payload protocol, the records the box writes,
the control API, the payload definition and the box config.

```ts
import { HoldInput, normalizeStatus } from "@dozebox/protocol/v1";
import Value from "typebox/value";

Value.Check(HoldInput, { reason: "nightly build", until: "2026-11-25T02:00:00.000Z" }); // true
const status = normalizeStatus(await response.json()); // tolerant: unknown phase reads as "serving"
```

| Import                                    | What                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `@dozebox/protocol/v1`                    | Payload protocol messages, events, `normalizeStatus`, `normalizeEvent` |
| `@dozebox/protocol/records`               | `rec/*` and `fence/*` records                                          |
| `@dozebox/protocol/control`               | `ControlStatus`, `normalizeControlStatus`                              |
| `@dozebox/protocol/payload`               | `PayloadDefinition`                                                    |
| `@dozebox/protocol/config`                | `BoxConfig`, `OperatorConfig`                                          |
| `@dozebox/protocol/schema/v1/<name>.json` | JSON Schema (draft 2020-12) for payloads in other languages            |

Spec: [docs/protocol/v1.md](../../docs/protocol/v1.md). Field tables: [docs/reference/protocol-v1.md](../../docs/reference/protocol-v1.md).
