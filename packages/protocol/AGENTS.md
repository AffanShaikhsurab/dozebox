# @dozebox/protocol

Schemas and types for the payload protocol (`src/v1/`), records (`src/records/v1.ts`), control API
(`src/control/v1.ts`), payload definition (`src/payload/v1.ts`) and config (`src/config/v1.ts`). May import:
`typebox` only.

| Change             | Edit                                                                                                                     | Then                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| A field or message | the schema in `src/`, a row in `test/samples.ts`; a new top-level type also goes in `src/registry.ts`                    | `pnpm --filter @dozebox/protocol gen:schema`, commit `schema/v1/` and `docs/reference/protocol-v1.md` |
| A reader fallback  | `src/v1/normalize.ts` or `normalizeControlStatus`, a `*.future.json` fixture in `packages/testkit/fixtures/protocol/v1/` | `pnpm --filter @dozebox/protocol test`                                                                |

Traps:

- Request schemas set `additionalProperties: false`; response schemas must not (readers tolerate additions).
- A new enum value is a minor and ships here one minor before the agent emits it (`docs/protocol/v1.md#versioning`).
- Never edit `schema/v1/*.json` by hand: `check:schema` fails on drift.
