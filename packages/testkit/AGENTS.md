# @dozebox/testkit

Fakes (`src/fakes/`: clock, fs, exec, IMDS), contract suites (`src/contracts/`) and fixtures (`fixtures/`). May
import: `protocol`, `core`. Never imported by production code (only from tests, as a dev dependency).

| Change             | Edit                                                                                    | Test                                   |
| ------------------ | --------------------------------------------------------------------------------------- | -------------------------------------- |
| A fake             | `src/fakes/<name>.ts`, export from `src/fakes/index.ts`                                 | `test/<name>.test.ts`                  |
| A port contract    | `src/contracts/<port>.ts`; run it against the fake and every real adapter               | the adapter's package tests            |
| A protocol fixture | `fixtures/protocol/v1/*.json`; `*.future.json` carry later-minor fields and enum values | `pnpm --filter @dozebox/protocol test` |

Traps:

- Fakes never touch real time or real hosts. `FakeImds` binds `127.0.0.1` only; time moves only through
  `FakeClock.advance`.
- `FakeExec` rejects any command no script answers, so a test cannot run something it did not expect.
