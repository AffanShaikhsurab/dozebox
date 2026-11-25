# @dozebox/sim

The seeded fault simulator (S1, S2): the TypeScript port of the legacy simulator, wired to `@dozebox/core`. One seed
is one simulated box over a day: a person who wakes and sleeps it, Spot reclaims, payload faults, capacity outages,
a volume tagged `active=false`, stale EC2 reads, lost, late and duplicated events, crashed control invocations and
killed agent processes. Same seed, same run, byte for byte; no wall clock, no `Math.random`, no network.

```
pnpm --filter @dozebox/sim sim --seeds 5000          # a census, judged against src/known.ts (exit 1 on a regression)
pnpm --filter @dozebox/sim sim --seed 2936 --trace 80 # replay one seed with its trace
pnpm --filter @dozebox/sim sim:judge                 # re-introduced historic bugs must still be found
pnpm --filter @dozebox/sim test                      # 1,000 seeds plus the scenarios (SIM_SEEDS=n for more)
```

## What is modelled

| File                       | What it is                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `world/`                   | The clock (generator processes on one event queue), the fake EC2 persistent Spot instance and its request, the Auto Scaling group, the EBS volume (single attach, the active tag as the fence), EventBridge. Timings from `measured.ts`, each with its source.                                                                          |
| `control/`                 | The control function's shell around core: `/v1/wake` (`decideWake`, one conditional write), `/v1/park` (`decidePark`), the EC2 event handler (R1: records only), the tick (lease, observe, `decideReconcile`, act with a re-read, the R3 judge). Invocations have call latency, crashes and the timeout.                                |
| `agent/`                   | The agent of one instance: attach and mount, the payload unit with restarts, `serving` at the first passing health check, the watchdog (`decideHealth`), the idle loop (`idleVerdict`), the Spot watcher with the early self-stop, the park with the sleep fence (R2), the failsafe. Any agent process can be killed between two calls. |
| `config.ts`, `scenario.ts` | The seed's knobs and day. `bugs` re-introduces historic bugs for the judge.                                                                                                                                                                                                                                                             |
| `invariants/`              | World invariants against the truth (safety after every event, liveness at deadlines), each failure in a class decided from the truth.                                                                                                                                                                                                   |
| `known.ts`                 | Open classes with id, rate per 100,000 seeds, replay seed and owner; the census judge.                                                                                                                                                                                                                                                  |

## Assumed behaviour of the fake

No session measured these; each is the documented or the easiest choice, and a real-AWS calibration should replace
them: DetachVolume is accepted in any instance state (a volume the guest has mounted stays busy until unmounted);
AttachVolume is accepted for a pending instance; StartInstances on a running instance succeeds without effect; Auto
Scaling describes are not delayed; a group instance is InService 0 to 4 s after running and a reclaimed one is replaced
30 to 90 s later; the Spot request reads `marked-for-stop` for the whole stop.
