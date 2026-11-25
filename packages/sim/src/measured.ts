// Every timing of the fake AWS, with its source (port of legacy sim/measured.mjs, values unchanged): WE, WF, WH are
// the we-resume-e2e, wf-chaos and wh-verify sessions of the legacy runner; PLAN is the legacy plan v5. ASSUMED marks
// what no session measured. [lo, hi] is drawn uniformly; a bare number is a constant.
import type { Rng } from "./prng.ts";

const s = (n: number): number => n * 1000;
const min = (n: number): number => n * 60_000;

export type Span = number | readonly [number, number];

export const MEASURED = {
  /** Stop issued to `stopped`: 10 s (WE Check 4a), 29 s (WF adoption). */
  stopSettleMs: [s(10), s(30)],
  /** `stopped` to Spot request `disabled / instance-stopped-by-user`: 35 to 100 s (WE Check 1), 101 s (WF). */
  requestDisabledAfterUserStopMs: [s(35), s(101)],
  /** After an EC2 stop (FIS or reclaim): 96 s (WE Check 4b). */
  requestDisabledAfterEc2StopMs: [s(80), s(100)],
  /** StartInstances to `running`: 5 to 8 s of `pending` (WE Check 1). */
  pendingMs: [s(5), s(8)],
  /** `running` to the agent starting, persistent resume (WE Check 1 boot timeline). */
  persistentOsUpMs: [s(7), s(10)],
  /** The payload answers 3.5 to 3.8 s after its unit starts (WE Check 1), 3.2 s (WF D3). */
  serverStartMs: [s(3), s(4)],
  /** Stopping the payload unit: the SIGTERM finalizer, 8.4 s (WF D2a), 14 s (WE Check 4a). */
  serverStopMs: [s(8), s(15)],
  /** StartInstances on an instance EC2 stopped: accepted in WE Check 4b, refused (no capacity) in WH Step 3a. */
  interruptedStartRefusedP: 0.5,
  /** desired 0 to 1, to a `pending` instance: under 15 s (WE Check 4a), 6 s (WF D3). */
  groupLaunchMs: [s(5), s(15)],
  /** `pending` to the agent running on a fresh instance (WE Check 4a 47 s; WF D3 56 s). */
  groupOsUpMs: [s(47), s(56)],
  /** Terminate (desired 0) to `terminated`: under 75 s (WH Step 3b). */
  terminateMs: [s(20), s(75)],
  /** ASSUMED: the group retries a launch that lacked Spot capacity. */
  launchRetryMs: s(60),
  /** ASSUMED: a reclaimed group instance is replaced after the EC2 health check notices. */
  asgUnhealthyMs: [s(30), s(90)],
  /** ASSUMED: `Pending` to `InService` after `running` (no lifecycle hooks). */
  inServiceMs: [0, s(4)],
  attachMs: [s(5), s(12)],
  detachMs: [s(1), s(10)],
  /** ASSUMED: the block device node appears after the attachment reports `attached`. */
  deviceAppearsMs: [s(1), s(3)],
  noticeLeadMs: s(120),
  /** EC2 Spot warning event to the control function: 2 s (WE Check 4a). */
  warningEventDelayMs: [s(1), s(3)],
  /** `stopped` state-change event to the control function: 0.8 s (WE Check 4a). */
  stateEventDelayMs: [s(0.5), s(2)],
  /** The control function's timeout as the legacy sim modelled it. */
  lambdaTimeoutMs: s(30),
  /** ASSUMED: one SDK call from the control function; it only sets how invocations interleave. */
  lambdaCallMs: [20, 250],
  /** The reconcile schedule, every minute. */
  reconcileEveryMs: min(1),
  /** AWS retries a failed asynchronous invoke twice, after 1 and 2 minutes. */
  asyncRetryMs: [min(1), min(2)],
  /** ASSUMED upper bound of a stale EC2 describe (eventually consistent). */
  staleReadMaxMs: s(12),
  /** ASSUMED tail: 2 % of stale reads run up to a minute. */
  staleTailP: 0.02,
  staleTailMaxMs: s(60),
  /** SSM/state lag a seed can turn on. */
  ssmLagMs: s(3),
  /** ASSUMED: one AWS call from the agent. */
  cliCallMs: [150, 900],
  /** IMDS poll of the Spot watcher. */
  imdsPollMs: s(5),
  idleMinutes: 30,
} as const satisfies Record<string, Span>;

export const draw = (rng: Rng, value: Span): number => (typeof value === "number" ? value : rng.range(value));
