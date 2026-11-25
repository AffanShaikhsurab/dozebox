// The tick's steps for one snapshot, in the order the shell runs them. Ported without change of behaviour from the
// legacy control's `decideReconcile` (`wake.mjs`). The typed single-action reconciler of part 6 §6.3 is `decide.ts`.
import { MINUTE } from "../time/index.ts";
import { isLive, isLiveState, type Snapshot } from "./facts.ts";
import { FALLBACK_REASON_MS, newestLaunchMs, pickPersistent, replacingNow, view } from "./model.ts";

/** A5(a): wake when next-wake-at is at most 1 min away or at most 30 min overdue. */
export const WAKE_LEAD_MS = 1 * MINUTE;
export const WAKE_GRACE_MS = 30 * MINUTE;

export type Step =
  | { readonly action: "stop-loser-persistent" | "persistent-duplicate"; readonly instanceId: string }
  | { readonly action: "park-loser-fallback" }
  | { readonly action: "fallback"; readonly reason: "interrupted" }
  | { readonly action: "release-volume" }
  | { readonly action: "wake"; readonly via: "intent" | "schedule" }
  | { readonly action: "wake-skipped-already-woken" | "wake-skipped-error" }
  | { readonly action: "on-demand-reset" | "on-demand-fallback" };

export type StepsDeps = {
  /** The public state of a persistent-instance snapshot (the status projection lives in the shell). */
  readonly persistentState: (snapshot: Snapshot) => string;
};

/**
 * The reconcile steps for one run. Extra snapshot fields: `persistents` (every persistent instance read), `asg`
 * ({ desired, onDemandPercent, instances }), `nextWakeAt` (ms or null).
 */
export function decideSteps(snapshot: Snapshot, deps: StepsDeps): Step[] {
  const { asg, nowMs } = snapshot;
  const persistents = snapshot.persistents ?? [];
  const primary = pickPersistent(persistents, snapshot.volume ?? null);
  const asgInstances = (asg?.instances ?? []).filter(isLive);
  const asgLive = asgInstances.length > 0;
  const base: Snapshot = { ...snapshot, persistent: primary, asgLive };
  const v = view(base);
  const actions: Step[] = [];
  const stopping = new Set<string>();
  const stop = (action: "stop-loser-persistent" | "persistent-duplicate", instanceId: string): void => {
    if (stopping.has(instanceId)) return;
    stopping.add(instanceId);
    actions.push({ action, instanceId });
  };
  const desired = asg?.desired ?? 0;

  // Volume holder wins.
  const holder = snapshot.volume?.attachedTo ?? null;
  const livePersistents = persistents.filter((p) => isLiveState(p.state));
  if (holder && asgInstances.some((i) => i.id === holder)) {
    for (const p of livePersistents) stop("stop-loser-persistent", p.id);
  }
  const persistentHolds = holder !== null && persistents.some((p) => p.id === holder);
  const holderLive = persistentHolds && livePersistents.some((p) => p.id === holder);
  // After an interruption warning the group instance is the designated successor.
  const successor = persistentHolds && v.interruptedIntent;
  // A sleep after the warning ends the replacement, but the old instance still holds the volume: park the replacement
  // once it has stopped, not while it holds the volume of the hand-off.
  const sleepStopping =
    v.sleepFenceMs !== null &&
    v.persistent?.id === holder &&
    (v.persistent?.state === "stopping" || v.persistent?.state === "running") &&
    v.sleepFenceMs >= (v.launchedMs ?? 0) &&
    nowMs - v.sleepFenceMs < 3 * MINUTE;
  // A wake that went to the group while a stopped persistent instance still holds the volume: release it to the group.
  const holderStopped = persistentHolds && !successor && v.persistent?.state === "stopped";
  const releaseToGroup =
    holderStopped &&
    (asgLive || desired >= 1) &&
    (v.intentFresh ||
      (v.intent?.fallbackReason != null && v.intentMs !== null && nowMs - v.intentMs < FALLBACK_REASON_MS)) &&
    snapshot.volume?.attachmentState !== "detaching";
  // A live holder also beats a group that is still trying to launch.
  if (!successor && !sleepStopping && !releaseToGroup && persistentHolds && (asgLive || (holderLive && desired >= 1))) {
    actions.push({ action: "park-loser-fallback" });
  }
  if (persistents.length > 1) {
    for (const p of livePersistents) if (p.id !== primary?.id) stop("persistent-duplicate", p.id);
  }

  const asgIdle = desired < 1 && !asgLive;
  const persistentStopped = primary?.state === "stopped" || primary?.state === "stopping";
  if (asgIdle && persistentStopped) {
    if (replacingNow(v)) actions.push({ action: "fallback", reason: "interrupted" });
    else if (v.intentFresh) actions.push({ action: "wake", via: "intent" });
  }

  // The persistent instance has stopped while the successor is on its way: free the volume now.
  if (
    successor &&
    primary?.state === "stopped" &&
    (desired >= 1 || asgLive) &&
    snapshot.volume?.attachmentState !== "detaching" &&
    !actions.some((a) => a.action === "fallback")
  ) {
    actions.push({ action: "fallback", reason: "interrupted" });
  }
  if (releaseToGroup && !actions.some((a) => a.action === "fallback")) actions.push({ action: "release-volume" });

  // Scheduled wake (next-wake-at), when nothing is up. A fresh intent already covers a wake.
  const next = snapshot.nextWakeAt ?? null;
  const nothingUp = asgIdle && !v.liveNow;
  const wakeQueued = actions.some((a) => a.action === "wake" || a.action === "fallback");
  if (nothingUp && !wakeQueued && next !== null && next >= nowMs - WAKE_GRACE_MS && next <= nowMs + WAKE_LEAD_MS) {
    // Only an error the box wrote stops a scheduled wake; a failed earlier wake must not cancel every later one.
    const own: Snapshot = { ...base, lastError: snapshot.boxError === undefined ? base.lastError : snapshot.boxError };
    if (deps.persistentState(own) === "stopped-error") actions.push({ action: "wake-skipped-error" });
    else if (newestLaunchMs(snapshot, v) >= next - WAKE_LEAD_MS) actions.push({ action: "wake-skipped-already-woken" });
    else actions.push({ action: "wake", via: "schedule" });
  }

  // The group's On-Demand fallback and its reset.
  if (desired < 1) {
    if (asg?.onDemandPercent === 100) actions.push({ action: "on-demand-reset" });
  } else if (
    asg?.od === undefined &&
    asg?.onDemandPercent === 0 &&
    !asgLive &&
    !v.liveNow &&
    snapshot.asgStatus?.state === "waiting-capacity"
  ) {
    actions.push({ action: "on-demand-fallback" });
  }
  return actions;
}
