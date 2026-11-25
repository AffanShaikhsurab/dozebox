// The awake caps and the On-Demand allowance, judged from facts the box cannot write. Ported without change of behaviour
// from the legacy control's `caps.mjs` (its pure part); the counting from EC2 state history is `history.ts`.
import { DAY, HOUR, MINUTE } from "../time/index.ts";

/** Minutes. `warn` and `rewake` follow `park` (2 h before, 4 h under) unless the stack says otherwise. */
export const AWAKE_CAP_DEFAULTS = Object.freeze({
  parkMinutes: 16 * 60,
  warnMinutes: 14 * 60,
  rewakeMinutes: 12 * 60,
  perWakeMinutes: 18 * 60,
  overrideMinutes: 20 * 60,
  onDemandMinutes: 3 * 60,
});

export type CapConfig = {
  readonly parkMinutes: number;
  readonly warnMinutes: number;
  readonly rewakeMinutes: number;
  readonly perWakeMinutes: number;
  readonly overrideMinutes: number;
  /** Null switches only the On-Demand rule off. */
  readonly onDemandMinutes: number | null;
};

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const timeMs = (iso: unknown): number | null => {
  const ms = Date.parse(String(iso ?? ""));
  return Number.isNaN(ms) ? null : ms;
};

/**
 * The caps JSON (rendered by Terraform) to the limits, or null when the caps are off. A number that does not parse falls
 * back to the default instead of turning a cap off; `"onDemandMinutes": null` switches only that rule off.
 */
export function parseCapConfig(text: unknown): CapConfig | null {
  const raw = typeof text === "string" ? text.trim() : "";
  if (raw === "") return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const given = (parsed !== null && typeof parsed === "object" ? parsed : {}) as Readonly<Record<string, unknown>>;
  const pick = (key: keyof typeof AWAKE_CAP_DEFAULTS): number => {
    const v = given[key];
    return positive(v) ? v : AWAKE_CAP_DEFAULTS[key];
  };
  const parkMinutes = pick("parkMinutes");
  return {
    parkMinutes,
    warnMinutes: Math.min(pick("warnMinutes"), parkMinutes),
    rewakeMinutes: Math.min(pick("rewakeMinutes"), parkMinutes),
    perWakeMinutes: pick("perWakeMinutes"),
    overrideMinutes: Math.max(pick("overrideMinutes"), parkMinutes),
    onDemandMinutes: given["onDemandMinutes"] === null ? null : pick("onDemandMinutes"),
  };
}

export type Bucket = { readonly at: number; readonly minutes: number };

/**
 * Running minutes from hourly buckets. A bucket counts at most 60 minutes however many targets ran in it (a hand-off
 * between the instance and the group must not count twice).
 */
export function sumMinutes(
  series: ReadonlyArray<ReadonlyArray<{ readonly at?: unknown; readonly value?: unknown } | null> | null | undefined>,
  periodMs = HOUR,
): { minutes: number; buckets: Bucket[] } {
  const perBucket = new Map<number, number>();
  for (const points of series)
    for (const point of points ?? []) {
      const at = point?.at;
      const value = point?.value;
      if (typeof at === "number" && Number.isFinite(at) && typeof value === "number" && Number.isFinite(value))
        perBucket.set(at, (perBucket.get(at) ?? 0) + value);
    }
  const cap = periodMs / MINUTE;
  const buckets = [...perBucket.entries()]
    .map(([at, minutes]) => ({ at, minutes: Math.min(cap, Math.round(minutes)) }))
    .toSorted((a, b) => a.at - b.at);
  return { minutes: buckets.reduce((sum, b) => sum + b.minutes, 0), buckets };
}

/** When the rolling sum is back at `rewakeMinutes` if nothing runs meanwhile; null when waiting never does it. */
export function wakesAtFor(
  buckets: ReadonlyArray<Bucket>,
  o: { readonly rewakeMinutes: number; readonly nowMs: number; readonly periodMs?: number },
): number | null {
  const periodMs = o.periodMs ?? HOUR;
  let total = buckets.reduce((sum, b) => sum + b.minutes, 0);
  if (total <= o.rewakeMinutes) return o.nowMs;
  for (const bucket of buckets.toSorted((a, b) => a.at - b.at)) {
    total -= bucket.minutes;
    if (total <= o.rewakeMinutes) return Math.max(o.nowMs, bucket.at + periodMs + DAY);
  }
  return null;
}

export type Override = { readonly at: string | null; readonly until: string; readonly by: unknown };

export const overrideActive = (override: Override | null, nowMs: number): boolean =>
  override !== null && (timeMs(override.until) ?? 0) > nowMs;

const SLACK_BEFORE_ON_DEMAND_MS = 30 * MINUTE;

/** When an unattended run must be done: 07:00 the next local morning for a run started after 18:00, else 2 h after the first Spot refusal. */
export function unattendedDeadlineMs(i: {
  readonly startedMs: number;
  readonly firstRefusalMs: number;
  readonly utcOffsetMinutes?: number;
}): number {
  const offset = i.utcOffsetMinutes ?? 0;
  const local = new Date(i.startedMs + offset * MINUTE);
  if (local.getUTCHours() < 18) return i.firstRefusalMs + 2 * HOUR;
  const morning = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 7);
  return morning - offset * MINUTE;
}

/** An unattended wake may take On-Demand once its slack (deadline - now - remaining work) is 30 minutes or less. */
export const unattendedMayUseOnDemand = (i: {
  readonly nowMs: number;
  readonly deadlineMs: number;
  readonly expectedRemainingMs: number;
}): boolean => i.deadlineMs - i.nowMs - i.expectedRemainingMs <= SLACK_BEFORE_ON_DEMAND_MS;

export type CapRule = "frozen" | "native" | "awake-24h" | "per-wake" | "on-demand-hours";
export type CapVerdict = {
  readonly awakeMinutes: number;
  readonly onDemandMinutes: number | null;
  readonly noOnDemand: boolean;
  readonly warn: boolean;
  readonly rule: CapRule;
  readonly park: boolean;
  readonly blocksWake: boolean;
  readonly limitMinutes: number | null;
  readonly alarm?: string | undefined;
  readonly frozen?: unknown;
};
export type RunningMachine = {
  readonly state: string;
  readonly launchedAt?: string | null;
  readonly lifecycle?: string | null;
};

/**
 * The cap that holds now, or null; `held` is the previous decision (the wake-again hysteresis). Rules in order: frozen,
 * native (a kill-switch alarm is in ALARM), awake-24h, per-wake, on-demand-hours. `warn` and `noOnDemand` ride along.
 */
export function decideAwakeCap(i: {
  readonly awakeMinutes: number;
  readonly onDemandMinutes?: number | null;
  readonly running?: ReadonlyArray<RunningMachine>;
  readonly alarms?: ReadonlyArray<{ readonly name?: string; readonly state?: string } | null>;
  readonly override?: Override | null;
  readonly held?: { readonly rule?: unknown; readonly blocksWake?: unknown } | null;
  readonly frozen?: unknown;
  readonly cfg: CapConfig;
  readonly nowMs: number;
}): CapVerdict | null {
  const { awakeMinutes, cfg, nowMs } = i;
  const onDemandMinutes = i.onDemandMinutes === undefined ? 0 : i.onDemandMinutes;
  const frozen = i.frozen ?? null;
  const live = (i.running ?? []).filter((r) => r.state === "pending" || r.state === "running");
  const raised = overrideActive(i.override ?? null, nowMs);
  const parkAt = raised ? cfg.overrideMinutes : cfg.parkMinutes;
  const warnAt = raised ? cfg.overrideMinutes - (cfg.parkMinutes - cfg.warnMinutes) : cfg.warnMinutes;
  const perWakeAt = raised ? cfg.overrideMinutes : cfg.perWakeMinutes;
  const noOnDemand = cfg.onDemandMinutes !== null && (onDemandMinutes ?? 0) >= cfg.onDemandMinutes;
  const base = { awakeMinutes, onDemandMinutes, noOnDemand, warn: false };

  if (frozen !== null) return { ...base, rule: "frozen", park: true, blocksWake: true, limitMinutes: null, frozen };
  const firing = (i.alarms ?? []).find((a) => a?.state === "ALARM");
  if (firing) return { ...base, rule: "native", park: true, blocksWake: true, alarm: firing.name, limitMinutes: null };

  const heldByCap = i.held?.rule === "awake-24h" && i.held.blocksWake === true;
  if (awakeMinutes >= parkAt || (heldByCap && !raised && awakeMinutes > cfg.rewakeMinutes))
    return { ...base, rule: "awake-24h", park: true, blocksWake: true, limitMinutes: parkAt };

  const launched = live.map((r) => timeMs(r.launchedAt)).filter((ms): ms is number => ms !== null);
  const oldest = launched.length > 0 ? Math.min(...launched) : null;
  if (oldest !== null && nowMs - oldest >= perWakeAt * MINUTE)
    return { ...base, rule: "per-wake", park: true, blocksWake: false, limitMinutes: perWakeAt };

  if (noOnDemand && live.some((r) => r.lifecycle === "on-demand"))
    return { ...base, rule: "on-demand-hours", park: true, blocksWake: false, limitMinutes: cfg.onDemandMinutes };

  if (awakeMinutes >= warnAt)
    return { ...base, warn: true, rule: "awake-24h", park: false, blocksWake: false, limitMinutes: parkAt };
  if (noOnDemand)
    return { ...base, rule: "on-demand-hours", park: false, blocksWake: false, limitMinutes: cfg.onDemandMinutes };
  return null;
}
