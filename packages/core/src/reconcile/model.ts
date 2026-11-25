// The persistent-instance model every legacy-shaped decision reads (ported from the legacy control's `model.mjs`):
// which instance counts, whether it was interrupted, and `view`, the derived facts about one snapshot.
import { MINUTE } from "../time/index.ts";
import {
  isLiveState,
  parseStoppedAt,
  REPLACING_WINDOW_MS,
  timeMs,
  type AsgStatusFacts,
  type InstanceRecord,
  type IntentFacts,
  type Iso,
  type PersistentFacts,
  type Snapshot,
  type SpotRequestFacts,
  type VolumeFacts,
} from "./facts.ts";

export const INTENT_FRESH_MS = 5 * MINUTE;
export const FALLBACK_REASON_MS = 30 * MINUTE;
/** How long a `fallback:interrupted` intent keeps its successor protected from the holder rules. */
const SUCCESSOR_WINDOW_MS = 10 * MINUTE;
/** An instance EC2 stopped is tried with StartInstances again once the interruption is this old. */
export const INTERRUPTED_RETRY_AFTER_MS = SUCCESSOR_WINDOW_MS;

const INTERRUPTION_SPOT_STATUSES = new Set([
  "instance-stopped-by-price",
  "instance-stopped-no-capacity",
  "instance-stopped-by-experiment",
]);
const INTERRUPTION_STATE_REASON = "Server.SpotInstanceShutdown";
const STATE_RANK: Readonly<Record<string, number>> = {
  running: 0,
  pending: 1,
  stopping: 2,
  stopped: 3,
  "shutting-down": 4,
};

/** True when the stopped persistent instance was stopped by EC2, not by us. Only EC2 can restart it. */
export function isInterrupted(
  persistent: PersistentFacts | null | undefined,
  spotRequest: SpotRequestFacts | null | undefined,
): boolean {
  if (!persistent || (persistent.state !== "stopped" && persistent.state !== "stopping")) return false;
  return (
    persistent.stateReasonCode === INTERRUPTION_STATE_REASON ||
    INTERRUPTION_SPOT_STATUSES.has(spotRequest?.statusCode ?? "")
  );
}

/**
 * True while the intent says the persistent instance is being replaced after an interruption warning, and it has not
 * been started again since, and no park came after the intent.
 */
export function hasInterruptedIntent(i: {
  readonly intent: IntentFacts | null | undefined;
  readonly persistent: PersistentFacts | null | undefined;
  readonly nowMs: number;
  readonly parkedMs?: number | null;
}): boolean {
  const intentMs = i.intent ? timeMs(i.intent.at) : null;
  if (i.intent?.fallbackReason !== "interrupted" || intentMs === null) return false;
  if (i.nowMs - intentMs >= SUCCESSOR_WINDOW_MS) return false;
  const parkedMs = i.parkedMs ?? null;
  if (parkedMs !== null && parkedMs >= intentMs) return false;
  const launchedMs = timeMs(i.persistent?.launchedAt);
  return launchedMs === null || intentMs >= launchedMs;
}

/** The instance every decision is about: the volume holder, then the most alive state, then the newest launch. */
export function pickPersistent(
  list: ReadonlyArray<PersistentFacts | null | undefined> | null | undefined,
  volume: VolumeFacts | null = null,
): PersistentFacts | null {
  const all = (list ?? []).filter((p): p is PersistentFacts => Boolean(p));
  if (all.length === 0) return null;
  const holder = volume?.attachedTo ? all.find((p) => p.id === volume.attachedTo) : undefined;
  if (holder) return holder;
  return (
    all.toSorted(
      (a, b) =>
        (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9) ||
        (timeMs(b.launchedAt) ?? 0) - (timeMs(a.launchedAt) ?? 0),
    )[0] ?? null
  );
}

export type View = {
  readonly persistent: PersistentFacts | null | undefined;
  readonly spotRequest: SpotRequestFacts | null;
  readonly asgStatus: AsgStatusFacts | null | undefined;
  readonly volume: VolumeFacts | null;
  readonly intent: IntentFacts | null;
  readonly serving: InstanceRecord | null;
  readonly bootTimeline: InstanceRecord | null;
  readonly rolledBack: unknown;
  readonly timelineThisRun: boolean;
  readonly lastError: unknown;
  readonly nowMs: number;
  readonly launchedMs: number | null;
  readonly stoppedAt: Iso | null;
  readonly stoppedMs: number | null;
  readonly intentMs: number | null;
  readonly intentFresh: boolean;
  readonly sleptMs: number;
  readonly groupParkedMs: number;
  readonly parkedMs: number;
  readonly sleepFenceMs: number | null;
  readonly holdsVolume: boolean;
  readonly liveNow: boolean;
  readonly asgLive: boolean;
  readonly asgDesired: boolean;
  readonly servedThisRun: boolean;
  readonly interruptedIntent: boolean;
  readonly interrupted: boolean;
};

const thisRun = (
  record: InstanceRecord | null,
  persistent: PersistentFacts | null | undefined,
  launchedMs: number | null,
) =>
  Boolean(persistent) &&
  record?.instanceId === persistent?.id &&
  launchedMs !== null &&
  (timeMs(record?.at) ?? -1) >= launchedMs;

export function view(snapshot: Snapshot): View {
  const { persistent, asgStatus, nowMs } = snapshot;
  const spotRequest = snapshot.spotRequest ?? null;
  const volume = snapshot.volume ?? null;
  const intent = snapshot.intent ?? null;
  const serving = snapshot.serving ?? null;
  const bootTimeline = snapshot.bootTimeline ?? null;
  const launchedMs = timeMs(persistent?.launchedAt);
  const stoppedAt = parseStoppedAt(persistent?.stateTransitionReason);
  const stoppedMs = timeMs(stoppedAt);
  const intentMs = intent ? timeMs(intent.at) : null;
  const holdsVolume = Boolean(persistent) && volume?.attachedTo === persistent?.id;
  const liveNow = isLiveState(persistent?.state);
  const asgDesired = (asgStatus?.desired ?? snapshot.asg?.desired ?? 0) >= 1;
  const asgLive = snapshot.asgLive === true;
  // A parked group counts from the start of its newest termination or launch; a stopped-error group from its error.
  const asgDown = asgStatus?.state === "parked" || asgStatus?.state === "stopped-error";
  const asgParkedMs = asgDown
    ? asgStatus?.state === "parked"
      ? (timeMs(snapshot.asgParkedAt) ?? timeMs(asgStatus.since))
      : Math.max(timeMs(asgStatus?.since) ?? 0, timeMs(snapshot.asgParkedAt) ?? 0)
    : null;
  // Every sleep leaves a fence, so one that stopped nothing still ends the wake intents and the replacement older than it.
  const sleepFenceMs = snapshot.sleepFenceMs ?? null;
  const parkedMs = Math.max(asgParkedMs ?? 0, sleepFenceMs ?? 0);
  const interruptedIntent = hasInterruptedIntent({
    intent,
    persistent,
    nowMs,
    parkedMs: parkedMs > 0 ? parkedMs : null,
  });
  // EC2 words the stop time to the second: a wake in the same second as the stop cannot be ordered against it, and the
  // sleep wins.
  const stoppedEndMs = stoppedMs === null ? null : stoppedMs + 999;
  const downMs = Math.max(stoppedEndMs ?? 0, parkedMs);
  // Only a deliberate stop counts as a sleep: a group that is `stopped-error` was parked by the box or the judge.
  const groupParkedMs = Math.max(asgStatus?.state === "parked" ? (asgParkedMs ?? 0) : 0, sleepFenceMs ?? 0);
  const sleptMs = Math.max(stoppedEndMs ?? 0, groupParkedMs);
  const intentFresh = intentMs !== null && nowMs - intentMs < INTENT_FRESH_MS && (downMs === 0 || intentMs > downMs);
  return {
    persistent,
    spotRequest,
    asgStatus,
    volume,
    intent,
    serving,
    bootTimeline,
    rolledBack: snapshot.rolledBack ?? null,
    timelineThisRun: thisRun(bootTimeline, persistent, launchedMs),
    lastError: snapshot.lastError ?? null,
    nowMs,
    launchedMs,
    stoppedAt,
    stoppedMs,
    intentMs,
    intentFresh,
    sleptMs,
    groupParkedMs,
    parkedMs,
    sleepFenceMs,
    holdsVolume,
    liveNow,
    asgLive,
    asgDesired,
    servedThisRun: thisRun(serving, persistent, launchedMs),
    interruptedIntent,
    interrupted:
      isInterrupted(persistent, spotRequest) ||
      (interruptedIntent && (persistent?.state === "stopped" || persistent?.state === "stopping")),
  };
}

/** When EC2 stopped the instance (ms), best guess: the warning's intent, the request's status time, the stop, the serve. */
export function interruptionTime(v: View): number | null {
  if (v.interruptedIntent && v.intentMs !== null) return v.intentMs;
  return timeMs(v.spotRequest?.statusUpdatedAt) ?? v.stoppedMs ?? timeMs(v.serving?.at);
}

/**
 * EC2 took the instance after it served, a fresh machine is on the way, and no sleep or park came after it last served.
 */
export function replacingNow(v: View): boolean {
  const at = interruptionTime(v);
  return (
    v.interrupted &&
    v.servedThisRun &&
    at !== null &&
    v.nowMs - at < REPLACING_WINDOW_MS &&
    (timeMs(v.serving?.at) ?? 0) > v.parkedMs
  );
}

export function newestLaunchMs(snapshot: Snapshot, v: View): number {
  return Math.max(v.launchedMs ?? 0, timeMs(snapshot.asgLastLaunchAt) ?? 0);
}

/** True when a sleep after the wake request cancelled it: nothing is up or wanted, and a stop or park came after it. */
export function wakeCancelled(snapshot: Snapshot, intent: IntentFacts | null | undefined): boolean {
  const intentMs = timeMs(intent?.at);
  if (intentMs === null || !intent) return false;
  const v = view(snapshot);
  if (v.liveNow || snapshot.asgLive === true || v.asgDesired) return false;
  const at = intent.fallbackReason === "interrupted" ? v.groupParkedMs : v.sleptMs;
  return at > 0 && at >= intentMs;
}

/** True when the machine that is up launched before this wake request and has served since its launch. */
export function answeredByServingBox(snapshot: Snapshot, intentMs: number): boolean {
  const { persistent, serving } = snapshot;
  const instance = isLiveState(persistent?.state) ? persistent : snapshot.asgStatus?.instance;
  const launchedMs = timeMs(instance?.launchedAt);
  if (!instance || launchedMs === null || launchedMs >= intentMs) return false;
  return serving?.instanceId === instance.id && (timeMs(serving.at) ?? -1) >= launchedMs;
}

/** Launch time (ms) of the machine that is up now: the persistent instance if live, else the group's; else null. */
export function liveLaunchedMs(snapshot: Snapshot): number | null {
  const instance = isLiveState(snapshot.persistent?.state)
    ? snapshot.persistent
    : snapshot.asgLive === true
      ? snapshot.asgStatus?.instance
      : null;
  return timeMs(instance?.launchedAt);
}
