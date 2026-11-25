# The cloud seam

Decisions in `core` never see a cloud. The shells (`control`, `agent`) talk to the cloud only through ports, small
TypeScript interfaces in cloud-neutral words, and only files under `src/adapters/aws/` import an SDK (the
dependency-cruiser rule `aws-sdk-only-in-adapters`). AWS is the one cloud. No second cloud is planned; this page says
what one would have to implement, so the ports stay honest.

## The ports

| Package   | Port (`src/ports/`)                           | What it means                                                   | AWS adapter         |
| --------- | --------------------------------------------- | --------------------------------------------------------------- | ------------------- |
| `control` | `Compute` (`compute.ts`)                      | The box's persistent machine; the fallback group of 0 or 1      | EC2, Auto Scaling   |
| `control` | `Volumes` (`volumes.ts`)                      | The box's data volumes, the `active` mark, create from snapshot | EBS (EC2 API)       |
| `control` | `RecordStore` (`records.ts`)                  | Small JSON records under one box root, read in one call         | SSM Parameter Store |
| `control` | `StateTable` (`state.ts`)                     | Lease with fencing token, fenced writes, idempotency keys       | DynamoDB            |
| `control` | `Notifier` (`notify.ts`)                      | One message to the operator's topic                             | SNS                 |
| `control` | `Spend` (`spend.ts`)                          | Month-to-date spend, null before there is data                  | Budgets             |
| `agent`   | `SelfStop` (`selfstop.ts`)                    | Stop this machine, or lower its group to 0                      | EC2, Auto Scaling   |
| `agent`   | `VolumeAttach` (`volumes.ts`)                 | Find and attach the box's active volume, behind the tag fence   | EBS (EC2 API)       |
| `agent`   | `RecordWriter`, `BoxNotifier`, `LogTransport` | Write records, publish attention, ship logs                     | SSM, SNS, Logs      |

## What a second cloud would implement

1. One adapter per port above, under `src/adapters/<cloud>/`, mapping every SDK error through a `from<Cloud>` twin of
   `fromAws` in `core/errors.ts`, so `RunnerError.code` and `retryable` mean the same everywhere.
2. The behaviour the contracts in `@dozebox/testkit/contracts` check (`ec2Port`, `groupPort`, `volumePort`,
   `recordStore`, `stateTable`, `spendPort`). Run them against the adapter and its emulator, the way the AWS wire tests
   run them against Floci.
3. The properties the reconciler relies on, which the contracts cannot fully prove:
   - a conditional write (compare-and-set on one item), for the lease and fenced writes;
   - a stop that keeps the machine's disks, and a start of the same machine;
   - a way to mark exactly one data volume as the box's, readable before attach and enforceable by IAM;
   - record writes up to 8 KiB.
4. Its own Terraform module. The AWS module in `terraform/` is not abstracted and should not be.

Reads may be stale (EC2 describes are eventually consistent), so the reconciler re-reads before acting; a new cloud's
adapter must not hide staleness behind caches. Where a cloud call takes no idempotency token (AWS `StartInstances`,
`StopInstances`, `SetDesiredCapacity`), the port's `token` is recorded only and the re-read rule carries idempotency.
