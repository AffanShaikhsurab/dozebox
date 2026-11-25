# @dozebox/client

Node client for payloads on a dozebox box. Rules: root `AGENTS.md`. May import: the table in `docs/internals/packages.md`.

- Runtime dependencies: `@dozebox/protocol` only. `node:` builtins are fine. Do not add `typebox`; read responses with
  the normalizers from `@dozebox/protocol/v1`.
- `src/index.ts` is the public surface (`CONTRACTS.md` row P2). `src/client.ts` (`makeClient`) takes injectable timers and
  delays; tests use it, `createClient` is the wrapper.
- `http.ts` is one attempt, `call.ts` the retry rule (retry only `retryable`), `holds.ts` keepHold, `events.ts` + `sse.ts`
  the stream. Tests run against an in-process server on a temp unix socket (`test/fake.ts`).
