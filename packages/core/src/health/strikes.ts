// Health strikes (part 4 §4.12): what the agent does after each health check. The numbers are the legacy watchdog's
// (restart at 5 and 10 unhealthy checks, park at 15), with the restart budget counted per rolling hour.
import { HOUR } from "../time/index.ts";

export type HealthConfig = {
  readonly restartAtStrikes: ReadonlyArray<number>;
  readonly parkAtStrikes: number;
  readonly restartsPerHour: number;
  /** Consecutive checks with no reply from the probe hosts before the network counts as down. */
  readonly netDownChecks: number;
};

export const HEALTH_DEFAULTS: HealthConfig = {
  restartAtStrikes: [5, 10],
  parkAtStrikes: 15,
  restartsPerHour: 2,
  netDownChecks: 3,
};

export type HealthState = {
  /** Consecutive unhealthy checks since the last healthy one. */
  readonly strikes: number;
  /** When the payload was restarted, kept for the rolling hour. */
  readonly restarts: ReadonlyArray<number>;
  /** Consecutive checks without network. */
  readonly netStrikes: number;
};

export const NEW_HEALTH_STATE: HealthState = { strikes: 0, restarts: [], netStrikes: 0 };

export type HealthCheck = {
  readonly now: number;
  /** This boot has served (its first healthy check wrote `rec/serving`). */
  readonly served: boolean;
  /** The definition's check passed and no live self-report says `ok: false`. */
  readonly healthy: boolean;
  /** Loop beats past their `expectEverySeconds` (see `missedLoops`). */
  readonly missedLoops: ReadonlyArray<string>;
  readonly netUp: boolean;
  /** The payload unit is `failed` (systemd start limit hit). */
  readonly unitFailed: boolean;
  readonly config?: HealthConfig;
};

/** `check` is the definition's check or a self-report; `loop:<name>` a missed loop beat. */
export type StrikeCause = "check" | `loop:${string}`;

export type HealthAction =
  | { readonly kind: "not-serving" }
  | { readonly kind: "serving" }
  | { readonly kind: "ok" }
  | { readonly kind: "hold" }
  | { readonly kind: "net-down" }
  | { readonly kind: "count"; readonly strikes: number; readonly cause: StrikeCause }
  | { readonly kind: "restart"; readonly strikes: number; readonly restart: number; readonly cause: StrikeCause }
  | {
      readonly kind: "park";
      readonly reason: "unhealthy" | "unit-failed";
      readonly strikes: number;
      readonly restarts: number;
    };

export type HealthDecision = {
  readonly action: HealthAction;
  readonly state: HealthState;
  /** The network came back after it had counted as down: send `net-back` once. */
  readonly netBack: boolean;
};

export function decideHealth(prev: HealthState, c: HealthCheck): HealthDecision {
  const cfg = c.config ?? HEALTH_DEFAULTS;
  const restarts = prev.restarts.filter((t) => c.now - t < HOUR);
  const state = { ...prev, restarts };
  if (c.unitFailed) {
    return {
      action: { kind: "park", reason: "unit-failed", strikes: prev.strikes, restarts: restarts.length },
      state,
      netBack: false,
    };
  }
  if (!c.netUp) {
    // A restart cannot fix the network: counting pauses, and the outage is told once.
    const netStrikes = prev.netStrikes + 1;
    const action: HealthAction = netStrikes === cfg.netDownChecks ? { kind: "net-down" } : { kind: "hold" };
    return { action, state: { ...state, netStrikes }, netBack: false };
  }
  const netBack = prev.netStrikes >= cfg.netDownChecks;
  const up = { ...state, netStrikes: 0 };
  if (!c.served) return { action: { kind: c.healthy ? "serving" : "not-serving" }, state: up, netBack };

  const missed = c.missedLoops[0];
  if (c.healthy && missed === undefined) return { action: { kind: "ok" }, state: { ...up, strikes: 0 }, netBack };
  const cause: StrikeCause = c.healthy && missed !== undefined ? `loop:${missed}` : "check";
  const strikes = prev.strikes + 1;
  const next = { ...up, strikes };
  const park: HealthAction = { kind: "park", reason: "unhealthy", strikes, restarts: restarts.length };
  if (strikes >= cfg.parkAtStrikes) return { action: park, state: next, netBack };
  if (cfg.restartAtStrikes.includes(strikes)) {
    if (restarts.length >= cfg.restartsPerHour) return { action: park, state: next, netBack };
    return {
      action: { kind: "restart", strikes, restart: restarts.length + 1, cause },
      state: { ...next, restarts: [...restarts, c.now] },
      netBack,
    };
  }
  return { action: { kind: "count", strikes, cause }, state: next, netBack };
}

export type LoopBeat = { readonly name: string; readonly at: number; readonly expectEveryMs: number | null };

/** Loop beats (part 4 §4.7) whose payload-declared deadline has passed. Loops without a deadline are only recorded. */
export function missedLoops(beats: ReadonlyArray<LoopBeat>, now: number): string[] {
  return beats.filter((b) => b.expectEveryMs !== null && now - b.at >= b.expectEveryMs).map((b) => b.name);
}
