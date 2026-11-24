# Concepts

| Word             | Meaning                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| Box              | One AWS machine, its data volume and the control function that wakes and parks it. Named by a box id.           |
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
| Drill            | A manual, real-AWS test that creates resources, checks behaviour, tears down and reports its cost.              |
