// The state the simulated control function keeps (the DynamoDB table and the box records, part 6 §6.3). Reads are
// strongly consistent, as DynamoDB conditional writes and consistent reads are.
import { EPOCH, HOUR } from "../world/clock.ts";
import { NEW_WAKE_BREAKER, type WakeBreaker } from "@dozebox/core/wake";
import type { Desired } from "@dozebox/core/reconcile";

type BoxRecord = { readonly instanceId: string; readonly at: number };

export type ControlState = {
  desired: Desired;
  fence: { readonly at: number; readonly phase: "before-stop" | "after-stop" } | null;
  interruption: BoxRecord | null;
  /** The newest Spot warning for any instance (the judge restarts its budget there). */
  lastWarningAt: number | null;
  lastStartError: { readonly at: number; readonly kind: "capacity" | "refused" | "other" } | null;
  lastLaunchAt: number | null;
  wakesAccepted: number[];
  /** The newest person's wake, accepted or answered `already-awake`: the judge measures from it. */
  lastWakeAt: number | null;
  breaker: WakeBreaker;
  /** `rec/serving`, written by the agent at its first passing health check (R4: tagged with the instance). */
  serving: BoxRecord | null;
  /** `rec/last-error`, written by the agent when a boot gives up. */
  bootError: (BoxRecord & { readonly text: string }) | null;
  /** Written by the judge (R3) when a wake is neither serving nor failed in time. */
  wakeFailure: { readonly at: number; readonly reason: string } | null;
  lease: { holder: number; expiresAt: number; token: number } | null;
  /** Timed wake requests the agent handed over at park (part 4 wakes): the tick wakes the box at each. */
  wakeRequests: Array<{ readonly key: string; readonly at: number }>;
};

export function newControlState(): ControlState {
  return {
    desired: { want: "asleep", since: EPOCH - 6 * HOUR, reason: "park:user", origin: "user" },
    fence: null,
    interruption: null,
    lastWarningAt: null,
    lastStartError: null,
    lastLaunchAt: null,
    wakesAccepted: [],
    lastWakeAt: null,
    breaker: NEW_WAKE_BREAKER,
    serving: null,
    bootError: null,
    wakeFailure: null,
    lease: null,
    wakeRequests: [],
  };
}
