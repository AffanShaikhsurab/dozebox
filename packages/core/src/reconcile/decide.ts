// The level-triggered reconciler of part 6 §6.3: one tick reads the whole observed state and the desired state, and
// returns at most one action. Rules R1 and R2 of part 9 §9.1 are built in:
//   R1  events only write records (an interruption is a record here); this function is the only one that acts, and the
//       shell re-reads EC2 and the fence before any destructive or billing action.
//   R2  every park writes `desired = asleep` with a time, so a wake older than the newest asleep is void by
//       construction; the sleep fence blocks starts and group raises while the agent is still parking.
import { MINUTE } from "../time/index.ts";

export type DesiredOrigin = "user" | "auto" | "schedule" | "event" | "operator" | "judge";
export type Desired = {
  readonly want: "awake" | "asleep";
  readonly since: number;
  readonly reason: string;
  readonly origin: DesiredOrigin;
};

export type Ec2State = "pending" | "running" | "stopping" | "stopped" | "shutting-down" | "terminated";

export type Observed = {
  readonly now: number;
  readonly persistent: {
    readonly id: string;
    readonly state: Ec2State;
    readonly stoppingAt: number | null;
    /** Spot request state; "active" while stopped means a stop is still in flight and a start is refused. */
    readonly spotRequest: "active" | "disabled" | "none";
    readonly launchedAt: number | null;
  } | null;
  readonly group: {
    readonly desired: 0 | 1;
    readonly instances: ReadonlyArray<{ readonly id: string; readonly state: Ec2State; readonly launchedAt: number }>;
  } | null;
  readonly volume: { readonly id: string; readonly attachedTo: string | null; readonly active: boolean };
  readonly sleepFence: {
    readonly at: number;
    readonly phase: "before-stop" | "after-stop";
    /** The agent's park reason (idle, user, unhealthy, reclaim, ...), when the record names one. */
    readonly reason?: string;
  } | null;
  /** The newest interruption record (Spot warning or EC2 stop for capacity), written by the event handler (R1). */
  readonly interruption: { readonly instanceId: string; readonly at: number } | null;
  /** The newest failed StartInstances of the persistent instance, written by the act step. */
  readonly lastStartError: { readonly at: number; readonly kind: "capacity" | "refused" | "other" } | null;
  readonly frozen: boolean;
  readonly onDemandAllowed: boolean;
  readonly lastLaunchAt: number | null;
};

export type FallbackWhy = "capacity" | "interrupted" | "refused" | "start-failed" | "group";

export type Action =
  | { readonly kind: "none"; readonly why: string }
  | { readonly kind: "start-persistent"; readonly id: string }
  | { readonly kind: "stop-persistent"; readonly id: string; readonly why: string }
  | { readonly kind: "raise-fallback"; readonly why: FallbackWhy }
  | { readonly kind: "lower-fallback"; readonly why: string }
  | { readonly kind: "release-volume"; readonly volumeId: string; readonly from: string }
  | { readonly kind: "wait"; readonly why: string; readonly recheckInMs: number };

/** The sleep fence blocks starts and group raises this long while the agent is still parking (R2). */
export const SLEEP_FENCE_MS = 10 * MINUTE;
/** After an interruption the group's instance replaces the persistent one for this long. */
export const REPLACING_WINDOW_MS = 15 * MINUTE;
/** A start refused because the Spot request is still stopping goes to the group after this long. */
export const REFUSED_FALLBACK_AFTER_MS = 3 * MINUTE;
const RECHECK_MS = 30_000;

type Group = NonNullable<Observed["group"]>;
type Persistent = NonNullable<Observed["persistent"]>;

const live = (s: Ec2State): boolean => s === "pending" || s === "running";
const groupUp = (g: Group | null): boolean => g !== null && (g.desired === 1 || g.instances.some((i) => live(i.state)));

/**
 * The interruption that the group's instance is replacing now: it is about the persistent instance's current boot,
 * it came after the wake (R2: a warning older than the newest desired state is void), and it is recent.
 */
function replacing(desired: Desired, o: Observed, p: Persistent | null): boolean {
  const i = o.interruption;
  if (i === null || p === null || i.instanceId !== p.id) return false;
  if (i.at < desired.since) return false;
  if (p.launchedAt !== null && p.launchedAt > i.at) return false;
  return o.now - i.at < REPLACING_WINDOW_MS;
}

/**
 * R2 for a park the agent did itself (idle, a person's sleep on the box, unhealthy): the box only writes
 * `fence/sleep-requested` (after-stop), so the tick records the park as `desired = asleep` at the fence's time. Null
 * when there is nothing to record: desired is already asleep, a wake came after the fence, a machine booted after it,
 * or it is a Spot reclaim (the group's instance replaces the persistent one, desired stays awake).
 */
export function agentPark(desired: Desired, o: Observed): Desired | null {
  const f = o.sleepFence;
  if (desired.want !== "awake" || f === null || f.phase !== "after-stop" || f.reason === "reclaim") return null;
  if (f.at < desired.since) return null;
  const launches = [o.persistent?.launchedAt ?? null, ...(o.group?.instances.map((i) => i.launchedAt) ?? [])];
  if (launches.some((t) => t !== null && t > f.at)) return null;
  if (replacing(desired, o, o.persistent)) return null;
  return { want: "asleep", since: f.at, reason: `park:agent:${f.reason ?? "self"}`, origin: "auto" };
}

/** At most one action per tick. Destructive and billing actions require a re-read in act() before they run. */
export function decideReconcile(desired: Desired, o: Observed): Action {
  const p = o.persistent;
  const g = o.group;
  if (o.frozen) {
    if (p !== null && live(p.state)) return { kind: "stop-persistent", id: p.id, why: "frozen" };
    if (groupUp(g)) return { kind: "lower-fallback", why: "frozen" };
    return { kind: "none", why: "frozen" };
  }

  // Volume holder wins: never two writers, whatever the desired state.
  const holder = o.volume.attachedTo;
  const groupHolds = holder !== null && g !== null && g.instances.some((i) => i.id === holder && live(i.state));
  if (groupHolds && p !== null && live(p.state)) return { kind: "stop-persistent", id: p.id, why: "loser" };
  const persistentHolds = holder !== null && p !== null && p.id === holder;
  const successor = desired.want === "awake" && replacing(desired, o, p);

  if (desired.want === "asleep") return park(o, p, g);

  // desired = awake from here. A park still in progress blocks starts and raises (R2).
  if (o.sleepFence !== null && o.sleepFence.phase === "before-stop" && o.now - o.sleepFence.at < SLEEP_FENCE_MS) {
    return { kind: "wait", why: "park-in-progress", recheckInMs: RECHECK_MS };
  }
  if (persistentHolds && p !== null && live(p.state) && groupUp(g) && !successor) {
    return { kind: "lower-fallback", why: "loser" };
  }
  if (p === null) {
    return groupUp(g) ? { kind: "none", why: "group-up" } : { kind: "raise-fallback", why: "group" };
  }
  if (successor) {
    if (!groupUp(g)) return { kind: "raise-fallback", why: "interrupted" };
    if (p.state === "stopped" && persistentHolds) return { kind: "release-volume", volumeId: o.volume.id, from: p.id };
    return { kind: "none", why: "replacing" };
  }
  if (groupUp(g)) {
    // The group serves this wake (fallback): hand it the volume once the persistent instance has stopped.
    if (p.state === "stopped" && persistentHolds) return { kind: "release-volume", volumeId: o.volume.id, from: p.id };
    return { kind: "none", why: "fallback-up" };
  }
  return wakePersistent(desired, o, p);
}

/** desired = asleep: stop what bills, whatever an older wake, warning or event said (R2). */
function park(o: Observed, p: Persistent | null, g: Group | null): Action {
  if (p !== null && live(p.state)) return { kind: "stop-persistent", id: p.id, why: "asleep" };
  if (groupUp(g)) return { kind: "lower-fallback", why: "asleep" };
  if (p !== null && p.state === "stopping") return { kind: "wait", why: "stopping", recheckInMs: RECHECK_MS };
  return { kind: "none", why: "parked" };
}

/** desired = awake, no group instance: start the persistent instance, wait for it, or go to the group. */
function wakePersistent(desired: Desired, o: Observed, p: Persistent): Action {
  switch (p.state) {
    case "pending":
    case "running":
      return { kind: "none", why: "awake" };
    case "stopping":
      // SIM-F4: a wake during a stop is kept; the instance is started once it has stopped.
      return { kind: "wait", why: "stopping", recheckInMs: RECHECK_MS };
    case "shutting-down":
    case "terminated":
      return { kind: "raise-fallback", why: "start-failed" };
    case "stopped":
      break;
  }
  const err = o.lastStartError !== null && o.lastStartError.at >= desired.since ? o.lastStartError : null;
  if (err?.kind === "capacity") return { kind: "raise-fallback", why: "capacity" };
  if (err?.kind === "other") return { kind: "raise-fallback", why: "start-failed" };
  const stoppedAt = p.stoppingAt ?? 0;
  if (err?.kind === "refused" || p.spotRequest === "active") {
    return o.now - stoppedAt < REFUSED_FALLBACK_AFTER_MS
      ? { kind: "wait", why: "spot-request-stopping", recheckInMs: RECHECK_MS }
      : { kind: "raise-fallback", why: "refused" };
  }
  return { kind: "start-persistent", id: p.id };
}
