# @dozebox/agent

The box agent (dozeboxd). Rules: root `AGENTS.md`. May import: the table in `docs/internals/packages.md`.

Entry points: `./main` (bin `dozeboxd`), `./ports/*`. The shell:

| Module                        | What                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `src/main.ts`                 | `readEnv` -> `makeDeps` -> `runAgent`; exits 1 when the agent cannot start                   |
| `src/run.ts`                  | `runAgent`: config, then loops, then `READY=1`; SIGTERM/SIGINT -> `STOPPING=1`, stop, exit 0 |
| `src/deps.ts`                 | `Deps` and the composition root (the only place adapters are built)                          |
| `src/env.ts`                  | the unit's environment (`DOZEBOX_*`, `NOTIFY_SOCKET`, `WATCHDOG_USEC`)                       |
| `src/config/`                 | SSM `config` + `payloads/<name>`, checked; last good copy in `<stateDir>/config/`            |
| `src/loops.ts`                | periodic loops: beats, errors vs bugs (3 bugs in a row exit 1), stop                         |
| `src/watchdog/loop.ts`        | `WATCHDOG=1` only when no loop is stuck                                                      |
| `src/records/publish.ts`      | stamp (`v`, `at`, writer tag), encode, put                                                   |
| `src/ports/`, `src/adapters/` | ports and their real adapters; AWS SDK only in `src/adapters/aws/`                           |

A new loop is a `MakeLoop` passed to `runAgent({ extra })`. Tests build `Deps` from fakes (`test/support.ts`); never
real systemd, IMDS or AWS.
