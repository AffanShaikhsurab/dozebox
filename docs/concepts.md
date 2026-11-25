# Concepts

| Word             | Meaning                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| Box              | One AWS machine, its data volume and the control function that wakes and parks it. Named by a box id.           |
| Stack            | The Terraform root in `./.dozebox` that calls the module for one box. The CLI reads its outputs.                |
| Payload          | The program the box exists to run. Defined by a payload definition (JSON). The runner knows no payload by name. |
| Agent            | `dozeboxd`, the process on the box that supervises payloads, decides idle, and parks the box.                   |
| Control function | The Lambda that reconciles desired and observed state, serves the control API and routes alerts.                |
| Park             | Stop the machine and keep the data volume. The box is asleep.                                                   |
| Wake             | Start the machine again, on Spot first and On-Demand as a fallback when allowed.                                |
| Hold             | A payload's lease that keeps the box awake for a reason until a time.                                           |
| Beat             | A payload's signal that work moved forward (progress) or that one of its loops ran (loop).                      |
| Presence         | A signal that a person is using the box now.                                                                    |
| Attention        | A payload's request to tell a human.                                                                            |
| Record           | A versioned JSON document the box writes to SSM for the control function (`rec/*`), or the reverse (`ctl/*`).   |
| Wake token       | The secret that lets a client read status and wake the box. Stored in SSM; `dozebox token show` prints a link.  |
| Cap              | A hard limit on awake hours per day, On-Demand hours per day or spend per month.                                |
| Freeze           | The kill switch: when a cap alarm fires, a deny policy stops starts and launches until `dozebox unfreeze`.      |
| Alert path       | How a message reaches you: the SNS topic (email), and the sinks the control function adds (ntfy, Web Push).     |
| Drill            | A manual, real-AWS test that creates resources, checks behaviour, tears down and reports its cost.              |

## What the box is doing

`/v1/status` reports one of six states. Any detail goes in other fields, so a client that knows these six keeps
working ([decision 0008](./decisions/0008-six-public-states.md)).

| State              | Meaning                                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| `parked`           | Asleep. The data volume is kept. A wake starts it.                          |
| `launching`        | A wake was accepted and the machine is starting.                            |
| `running`          | The machine is up. `servingSince` is set once the payload serves.           |
| `waiting-capacity` | Spot has no capacity and the box waits or falls back to On-Demand.          |
| `replacing`        | The instance is being replaced (a rebuild, or after a failure).             |
| `stopped-error`    | The control function gave up. `lastError` says why; wake again to retry it. |

The control function wants the box either `awake` or `asleep` (`desired`). A wake or park request only writes that
wish. A scheduled tick (every minute) compares it with what AWS reports and acts, so a request is never lost to a
crash between two calls.

## What keeps the box awake

The agent parks the box when nothing has kept it awake for `idle_minutes`. Three things count:

1. An open hold (`dozebox hold`, or `dozebox run -- <command>` while the command runs).
2. Presence: a person on the box (`dozebox presence`, or an SSH session). A browser tab that only views counts for a
   short grace after the last real input.
3. Recent activity: a progress beat (`dozebox beat`), and for a payload in health-only mode, a passing health check,
   CPU use or a TCP connection to a declared port.

The idle clock starts at the last of these, or at the moment the payload began serving.

A box with an open hold but no progress for `no_progress_park_minutes` parks anyway, and the control function alerts.
The agent (`dozeboxd`) applies these rules. Its release artifact is planned, so a stack deployed today runs the test
agent that powers off.

## Public surfaces

Everything a user or a payload can depend on is versioned with the project: the payload protocol, the records, the
control API, the CLI, the Terraform module and the config files. The rules are in
[Versioning](./protocol/v1.md#versioning).
