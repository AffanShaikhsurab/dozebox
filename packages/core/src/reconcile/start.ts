// What to do with the persistent instance when the box should be awake: start it, wait for it, or go to the fallback
// group. Ported without change of behaviour from the legacy control's `decideWake` (`wake.mjs`).
import { MINUTE } from "../time/index.ts";
import { timeMs, type Snapshot } from "./facts.ts";
import { INTERRUPTED_RETRY_AFTER_MS, interruptionTime, view, type View } from "./model.ts";

const REFUSED_FALLBACK_AFTER_MS = 3 * MINUTE;
const PENDING_STOP_SPOT_STATUSES = new Set(["marked-for-stop", "instance-stopped-by-user"]);

export type FallbackReason = "absent" | "capacity" | "interrupted" | "refused" | "start-failed";
export type StartDecision =
  | { readonly action: "none" }
  | { readonly action: "start" }
  | { readonly action: "wait" }
  | { readonly action: "fallback"; readonly reason: FallbackReason };

/** EC2 stopped it a while ago, no successor is being protected, and the volume is free or still with it. */
function canRetryInterrupted(v: View, snapshot: Snapshot): boolean {
  const stoppedAt = interruptionTime(v);
  if (stoppedAt === null || v.nowMs - stoppedAt < INTERRUPTED_RETRY_AFTER_MS || v.interruptedIntent) return false;
  const holder = snapshot.volume;
  return Boolean(holder) && (holder?.attachedTo === null || holder?.attachedTo === v.persistent?.id);
}

/** Which way a refused or failed StartInstances should go. */
function classifyStartError(error: unknown): "capacity" | "refused" | "state" | "other" {
  const e = (typeof error === "object" && error !== null ? error : {}) as {
    readonly name?: unknown;
    readonly code?: unknown;
    readonly message?: unknown;
  };
  const name = String(e.name ?? e.code ?? "");
  const text = `${name} ${String(e.message ?? "")}`;
  if (/InsufficientInstanceCapacity|capacity/i.test(text)) return "capacity";
  if (/IncorrectSpotRequestState/i.test(text)) return "refused";
  if (/IncorrectInstanceState/i.test(text)) return "state";
  return "other";
}

/**
 * Called at most twice: first with no `startError`, and again with the error StartInstances threw when the first
 * answer was `start`.
 *   none      something is already live or launching (idempotent)
 *   start     call StartInstances
 *   wait      it will be startable shortly; the intent is recorded and the tick retries
 *   fallback  launch through the group
 */
export function decideStart(snapshot: Snapshot): StartDecision {
  const v = view(snapshot);
  const { persistent, nowMs } = v;
  if (!persistent) return { action: "fallback", reason: "absent" };
  if (v.liveNow || v.asgLive || v.asgDesired) return { action: "none" };
  if (persistent.state === "stopping") return { action: "wait" };
  if (persistent.state !== "stopped") return { action: "fallback", reason: "start-failed" };
  if (v.interrupted && !canRetryInterrupted(v, snapshot)) return { action: "fallback", reason: "interrupted" };

  const refusedVerdict = (): StartDecision => {
    const stoppedMs = v.stoppedMs ?? timeMs(v.spotRequest?.statusUpdatedAt);
    return stoppedMs !== null && nowMs - stoppedMs < REFUSED_FALLBACK_AFTER_MS
      ? { action: "wait" }
      : { action: "fallback", reason: "refused" };
  };

  if (snapshot.startError) {
    switch (classifyStartError(snapshot.startError)) {
      case "capacity":
        return { action: "fallback", reason: "capacity" };
      case "refused":
        return refusedVerdict();
      case "state":
        return { action: "wait" };
      default:
        return { action: "fallback", reason: "start-failed" };
    }
  }
  // The request still says "active" with a stop in flight: StartInstances is certain to be refused.
  if (v.spotRequest?.state === "active" && PENDING_STOP_SPOT_STATUSES.has(v.spotRequest.statusCode ?? "")) {
    return refusedVerdict();
  }
  return { action: "start" };
}
