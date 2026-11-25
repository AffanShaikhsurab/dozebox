# @dozebox/core

Pure decision functions shared by the agent, the control function and the simulator. Rules: root `AGENTS.md`. May import: the table in `docs/internals/packages.md`.

Entry points (`package.json` `exports`), one per concept:

| Export                            | What                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `./idle`                          | `idleVerdict` (part 4 §4.16)                                                                                              |
| `./health`                        | `decideHealth` strikes (§4.12), `missedLoops`, `decideLiveness` (legacy liveness, facts not words)                        |
| `./wake`                          | `decideWake`, `decidePark`, wake budget and breaker, intent freshness (R2), `decideNoProgress`                            |
| `./reconcile`                     | `decideReconcile(desired, observed)` (one action per tick, R1/R2); the legacy-shaped `decideStart`, `decideSteps`, `view` |
| `./caps`                          | `decideAwakeCap`, `countAwake` from EC2 state history, `judgeSpend`                                                       |
| `./alerts`                        | `admitAlert` ledger, sink breaker, `routeAlert`, `escalationsDue`                                                         |
| `./summary`                       | `composeSummary` from brand and copy                                                                                      |
| `./records`, `./time`, `./errors` | records, time helpers, `RunnerError` and `fromAws`                                                                        |

The legacy control (`legacy/runner/control/core.mjs`) and the legacy box shim (`legacy/runner/test/shim/`) call these
modules, so the legacy tests and `node legacy/runner/test/shim/census.mjs` prove every change. Keep the `.ts` files
erasable-only (Node runs them without a build there) and free of `@dozebox/*` imports in the modules they load.
