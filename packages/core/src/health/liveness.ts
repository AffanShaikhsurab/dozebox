// The liveness rules, ported without change of behaviour from the legacy box's `lib-liveness-decide.mjs`: a stalled
// work loop, a dead tunnel, a lost network, with the restart and alert budgets. Actions carry facts, not text: the
// caller renders words from its own copy, so the runner names no payload.
import { HOUR, MINUTE } from "../time/index.ts";

/** Work is active but nothing moved for this long. */
export const DRIVER_STALL_MS = 15 * MINUTE;
export const IDLE_LOOP_STALL_MS = 5 * MINUTE;
const WATCHER_STALL_MS = 15 * MINUTE;
const ALERTS_STALL_MS = 30 * MINUTE;
const SHELLS_STALL_MS = 10 * MINUTE;
/** A heartbeat older than this is not being written; its loop stamps say nothing about the running payload. */
const HEARTBEAT_FRESH_MS = 2 * MINUTE;
/** A park that did not take is asked for again after this long. */
export const PARK_RETRY_MS = 10 * MINUTE;
export const TUNNEL_DOWN_MS = 10 * MINUTE;
export const NET_DOWN_STRIKES = 3;
const SERVER_RESTARTS_PER_HOUR = 2;
export const TUNNEL_RESTARTS_PER_HOUR = 3;
const TUNNEL_RESTART_COOLDOWN_MS = 5 * MINUTE;
/** A give-up parks the box unless a person used it within this long. No `presenceAt` means unknown: only alert. */
const PRESENCE_WINDOW_MS = 30 * MINUTE;
/** The same alert key is not repeated inside this window. */
export const ALERT_GAP_MS = HOUR;

export type LivenessKey =
  | "net-down"
  | "net-back"
  | "tunnel-back"
  | "tunnel-kick"
  | "tunnel-stuck"
  | "tunnel-park"
  | "server-restart"
  | "server-stuck"
  | "server-park"
  | "idle-loop-park";

type Severity = "page" | "notify" | "info";

export const LIVENESS_SEVERITY: Readonly<Partial<Record<LivenessKey, Severity>>> = Object.freeze({
  "net-down": "notify",
  "net-back": "info",
  "tunnel-back": "info",
  "tunnel-kick": "notify",
  "tunnel-stuck": "page",
  "server-restart": "notify",
  "server-stuck": "page",
  "idle-loop-park": "page",
});

export type LoopName = "idle" | "watcher" | "alerts" | "shells";

/** Why the payload needs a restart. The first one found is the one told. */
export type NeedRestart =
  | { readonly code: "tunnel-gone"; readonly minutes: number }
  | { readonly code: "work-silent"; readonly minutes: number; readonly active: number }
  | { readonly code: "work-stalled"; readonly minutes: number; readonly active: number }
  | { readonly code: "loop-quiet"; readonly loop: LoopName; readonly minutes: number };

/** The facts each action's words are made from. */
export type LivenessFacts = {
  readonly minutes?: number;
  readonly strikes?: number;
  readonly cause?: string | undefined;
  readonly restarts?: number;
  readonly limit?: number;
  readonly nobodyMinutes?: number;
  readonly why?: NeedRestart;
};

export type LivenessAction =
  | {
      readonly kind: "alert";
      readonly key: LivenessKey;
      readonly severity: Severity | undefined;
      readonly facts: LivenessFacts;
    }
  | { readonly kind: "park"; readonly key: LivenessKey; readonly severity?: Severity; readonly facts: LivenessFacts }
  | {
      readonly kind: "restart-tunnel";
      readonly key: "tunnel-kick";
      readonly pid: number | undefined;
      readonly severity: Severity;
      readonly facts: LivenessFacts;
    }
  | {
      readonly kind: "restart-server";
      readonly key: "server-restart";
      readonly severity: Severity;
      readonly facts: LivenessFacts;
    };

export type Heartbeat = {
  readonly at: number;
  readonly active?: number | null;
  readonly progressAt?: number | null;
  readonly presenceAt?: number | null;
  readonly ticks?: {
    readonly idleAt: number | null;
    readonly watcherAt: number | null;
    readonly alertsAt: number | null;
    readonly shellsAt: number | null;
  } | null;
};

export type TunnelProbe = {
  readonly expected: boolean;
  readonly roundTrip?: boolean | null;
  readonly pid?: number | null;
  readonly cause?: string | undefined;
};

export type LivenessState = {
  tunnelDownSince: number | null;
  tunnelLastOkAt: number | null;
  tunnelRestarts: number[];
  serverRestarts: number[];
  netStrikes: number;
  netDownSince: number | null;
  alerts: Record<string, number>;
  published: unknown;
  parkAskedAt: number | null;
  idleNullSince: number | null;
  tunnelGaveUp?: boolean;
  serverGaveUp?: boolean;
  [extra: string]: unknown;
};

export type LivenessInput = {
  readonly now: number;
  readonly servedAt: number | null;
  readonly hb: Heartbeat | null;
  readonly net: boolean;
  readonly tunnel: TunnelProbe;
  readonly state: Partial<LivenessState> | null | undefined;
};

const EMPTY: LivenessState = {
  tunnelDownSince: null,
  tunnelLastOkAt: null,
  tunnelRestarts: [],
  serverRestarts: [],
  netStrikes: 0,
  netDownSince: null,
  alerts: {},
  published: null,
  parkAskedAt: null,
  idleNullSince: null,
};

const minutes = (ms: number): number => Math.max(1, Math.round(ms / MINUTE));
const recent = (list: unknown, now: number): number[] =>
  Array.isArray(list) ? list.filter((t): t is number => Number.isFinite(t) && now - t < HOUR) : [];
const nobodyHere = (hb: Heartbeat | null, now: number): hb is Heartbeat & { presenceAt: number } =>
  hb?.presenceAt != null && now - hb.presenceAt >= PRESENCE_WINDOW_MS;

const LOOPS: ReadonlyArray<readonly ["watcherAt" | "alertsAt" | "shellsAt", number, LoopName, boolean]> = [
  ["watcherAt", WATCHER_STALL_MS, "watcher", true],
  ["alertsAt", ALERTS_STALL_MS, "alerts", false],
  ["shellsAt", SHELLS_STALL_MS, "shells", false],
];

/**
 * Pure. Returns what to do and the next state; the restart and alert budgets are charged here, so a failed command
 * still uses its slot.
 */
export function decideLiveness({ now, servedAt, hb, net, tunnel, state }: LivenessInput): {
  actions: LivenessAction[];
  state: LivenessState;
} {
  const s: LivenessState = {
    ...EMPTY,
    ...state,
    alerts: { ...state?.alerts },
    tunnelRestarts: recent(state?.tunnelRestarts, now),
    serverRestarts: recent(state?.serverRestarts, now),
  };
  const actions: LivenessAction[] = [];
  const say = (key: LivenessKey, facts: LivenessFacts): void => {
    const last = s.alerts[key];
    if (last !== undefined && now - last < ALERT_GAP_MS) return;
    s.alerts[key] = now;
    actions.push({ kind: "alert", key, severity: LIVENESS_SEVERITY[key], facts });
  };

  // Network. A reply from either probe is enough; a restart cannot fix it, so it only suppresses the restarts below.
  if (net) {
    if (s.netStrikes >= NET_DOWN_STRIKES) {
      delete s.alerts["net-down"];
      say("net-back", { minutes: minutes(now - (s.netDownSince ?? now)) });
    }
    s.netStrikes = 0;
    s.netDownSince = null;
  } else {
    s.netStrikes += 1;
    s.netDownSince ??= now;
    if (s.netStrikes === NET_DOWN_STRIKES) say("net-down", { strikes: NET_DOWN_STRIKES });
  }
  const netDown = !net;

  const needServer: NeedRestart[] = [];
  if (tunnel.expected && tunnel.roundTrip === true) {
    if (s.alerts["tunnel-kick"] !== undefined || s.alerts["tunnel-stuck"] !== undefined) {
      delete s.alerts["tunnel-kick"];
      delete s.alerts["tunnel-stuck"];
      say("tunnel-back", { minutes: minutes(now - (s.tunnelDownSince ?? now)) });
    }
    s.tunnelLastOkAt = now;
    s.tunnelDownSince = null;
    s.tunnelGaveUp = false;
  } else if (tunnel.expected && tunnel.roundTrip === false) {
    s.tunnelDownSince ??= now;
    const down = now - s.tunnelDownSince;
    if (down >= TUNNEL_DOWN_MS && !netDown && !s.tunnelGaveUp) {
      const last = s.tunnelRestarts.at(-1);
      const cause = tunnel.cause;
      if (tunnel.pid === null) {
        // A tunnel that never worked this boot may be off on purpose: not a reason to restart.
        if (s.tunnelLastOkAt !== null) needServer.push({ code: "tunnel-gone", minutes: minutes(down) });
      } else if (s.tunnelRestarts.length >= TUNNEL_RESTARTS_PER_HOUR) {
        s.tunnelGaveUp = true;
        const facts = { minutes: minutes(down), cause, restarts: s.tunnelRestarts.length };
        if (nobodyHere(hb, now)) {
          actions.push({
            kind: "park",
            key: "tunnel-park",
            facts: { ...facts, nobodyMinutes: minutes(now - hb.presenceAt) },
          });
        } else {
          say("tunnel-stuck", facts);
        }
      } else if (last === undefined || now - last >= TUNNEL_RESTART_COOLDOWN_MS) {
        s.tunnelRestarts.push(now);
        s.alerts["tunnel-kick"] = now;
        actions.push({
          kind: "restart-tunnel",
          pid: tunnel.pid,
          key: "tunnel-kick",
          severity: "notify",
          facts: { minutes: minutes(down), cause, restarts: s.tunnelRestarts.length, limit: TUNNEL_RESTARTS_PER_HOUR },
        });
      }
    }
  }

  // Work: active but nothing moves, or the heartbeat itself stopped.
  const active = hb?.active ?? 0;
  const since = Math.max(servedAt ?? 0, s.serverRestarts.at(-1) ?? 0);
  if (hb !== null && active > 0 && !netDown) {
    const beatQuiet = now - Math.max(hb.at, since);
    const workQuiet = now - Math.max(hb.progressAt ?? 0, since);
    if (beatQuiet >= DRIVER_STALL_MS) needServer.push({ code: "work-silent", minutes: minutes(beatQuiet), active });
    else if (workQuiet >= DRIVER_STALL_MS)
      needServer.push({ code: "work-stalled", minutes: minutes(workQuiet), active });
  }
  // The payload's own loops: each stamps a pass in the heartbeat. Stamps only count while the heartbeat is fresh.
  let idleLoopDead = false;
  const ticks = hb?.ticks ?? null;
  const beating = hb !== null && now - hb.at < HEARTBEAT_FRESH_MS;
  if (ticks === null || !beating || ticks.idleAt !== null) s.idleNullSince = null;
  else s.idleNullSince ??= now;
  if (ticks !== null && beating && !netDown) {
    const quiet = (at: number | null): number => now - Math.max(at ?? 0, since);
    const idleQuiet = ticks.idleAt === null ? now - Math.max(s.idleNullSince ?? now, since) : quiet(ticks.idleAt);
    if (idleQuiet >= IDLE_LOOP_STALL_MS) {
      idleLoopDead = true;
      needServer.push({ code: "loop-quiet", loop: "idle", minutes: minutes(idleQuiet) });
    }
    for (const [field, limit, loop, needsRuns] of LOOPS) {
      const at = ticks[field];
      if (at !== null && (!needsRuns || active > 0) && quiet(at) >= limit)
        needServer.push({ code: "loop-quiet", loop, minutes: minutes(quiet(at)) });
    }
  }
  const why = needServer[0];
  if (why !== undefined) {
    const restarts = s.serverRestarts.length;
    if (idleLoopDead && restarts >= SERVER_RESTARTS_PER_HOUR) {
      // A box whose idle loop is dead never sleeps: park it rather than pay for it awake.
      if (s.parkAskedAt === undefined || s.parkAskedAt === null || now - s.parkAskedAt >= PARK_RETRY_MS) {
        s.parkAskedAt = now;
        actions.push({ kind: "park", key: "idle-loop-park", severity: "page", facts: { why, restarts } });
      }
    } else if (s.serverGaveUp) {
      // Already told; quiet until the fault clears.
    } else if (restarts >= SERVER_RESTARTS_PER_HOUR) {
      s.serverGaveUp = true;
      if (nobodyHere(hb, now)) {
        actions.push({
          kind: "park",
          key: "server-park",
          facts: { why, restarts, nobodyMinutes: minutes(now - hb.presenceAt) },
        });
      } else {
        say("server-stuck", { why, restarts });
      }
    } else {
      s.serverRestarts.push(now);
      actions.push({
        kind: "restart-server",
        key: "server-restart",
        severity: "notify",
        facts: { why, restarts: s.serverRestarts.length, limit: SERVER_RESTARTS_PER_HOUR },
      });
    }
  }
  if (needServer.length === 0 && net) {
    s.serverGaveUp = false;
    s.parkAskedAt = null;
    delete s.alerts["server-stuck"];
  }
  return { actions, state: s };
}
