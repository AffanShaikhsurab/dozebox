// C3: the awake-hours and On-Demand-hours caps (core K4 `decideAwakeCap`), enforced by the tick. EC2 keeps no cheap
// state history, so every tick extends a log of running intervals (`awake-log`, last 24 h) from what it observed;
// overlaps count once (`unionMs`), so a reclaim hand-off is not counted twice. The verdict is stored in `caps` for
// the status view and the wake-again hysteresis of the next tick.
import { AWAKE_CAP_DEFAULTS, decideAwakeCap, unionMs, type CapConfig, type CapVerdict } from "@dozebox/core/caps";
import { DAY, MINUTE } from "@dozebox/core/time";
import { Type, type Static } from "typebox";
import type { ControlConfig } from "../config.ts";
import type { MachineView } from "../ports/compute.ts";
import type { Snapshot, TickDeps } from "../reconcile/types.ts";
import type { HeldLease } from "../state/index.ts";
import { CapsView, KEYS, readKey } from "../state/keys.ts";

/** A gap between two ticks longer than this is not counted as awake (the function was down, not the box up). */
const MAX_TICK_GAP_MS = 5 * MINUTE;

const AwakeLog = Type.Object({
  at: Type.Number(),
  intervals: Type.Array(
    Type.Object({
      id: Type.String(),
      lifecycle: Type.Union([Type.Literal("spot"), Type.Literal("on-demand")]),
      from: Type.Number(),
      to: Type.Number(),
    }),
  ),
});
type AwakeLog = Static<typeof AwakeLog>;
type Span = AwakeLog["intervals"][number];

/** The caps from DOZEBOX_CONTROL, or null when both are off. */
function capConfig(caps: ControlConfig["caps"]): CapConfig | null {
  const awake = caps.awakeHoursPerDay;
  const od = caps.onDemandHoursPerDay;
  if (awake === null && od === null) return null;
  const off = Number.MAX_SAFE_INTEGER;
  const park = awake === null ? off : awake * 60;
  return {
    parkMinutes: park,
    warnMinutes: Math.max(0, park - (AWAKE_CAP_DEFAULTS.parkMinutes - AWAKE_CAP_DEFAULTS.warnMinutes)),
    rewakeMinutes: Math.max(0, park - (AWAKE_CAP_DEFAULTS.parkMinutes - AWAKE_CAP_DEFAULTS.rewakeMinutes)),
    perWakeMinutes: awake === null ? off : AWAKE_CAP_DEFAULTS.perWakeMinutes,
    overrideMinutes: Math.max(AWAKE_CAP_DEFAULTS.overrideMinutes, park),
    onDemandMinutes: od === null ? null : od * 60,
  };
}

const isLive = (m: MachineView): boolean => m.state === "pending" || m.state === "running";

/** Extend the log with the machines running now. Pure. */
function extendLog(log: AwakeLog | null, running: ReadonlyArray<MachineView>, now: number): AwakeLog {
  const last = log?.at ?? null;
  const gapOk = last !== null && now - last <= MAX_TICK_GAP_MS;
  const spans: Span[] = (log?.intervals ?? []).filter((s) => s.to > now - DAY);
  for (const m of running) {
    const open = spans.findIndex((s) => s.id === m.id && last !== null && s.to >= last);
    const s = spans[open];
    if (s !== undefined && gapOk) {
      spans[open] = { ...s, to: now };
    } else {
      const from = Math.max(m.launchedAt, gapOk && last !== null ? last : now);
      spans.push({ id: m.id, lifecycle: m.lifecycle, from: Math.min(from, now), to: now });
    }
  }
  return { at: now, intervals: spans };
}

/** Minutes any machine ran, and minutes an On-Demand machine ran, in the 24 h before `now`. */
function countLog(log: AwakeLog, now: number): { readonly awake: number; readonly onDemand: number } {
  const clip = (s: Span) => ({ from: Math.max(s.from, now - DAY), to: s.to });
  const all = log.intervals.map(clip);
  const od = log.intervals.filter((s) => s.lifecycle === "on-demand").map(clip);
  return { awake: Math.round(unionMs(all) / MINUTE), onDemand: Math.round(unionMs(od) / MINUTE) };
}

/** Count, judge and store; the caller parks on `park` and keeps the group On-Demand-free on `noOnDemand`. */
export async function enforceCaps(deps: TickDeps, snap: Snapshot, lease: HeldLease): Promise<CapVerdict | null> {
  const now = snap.observed.now;
  const machines = [snap.facts.persistent, ...snap.facts.groups.flatMap((g) => g.machines)];
  const running = machines.filter((m): m is MachineView => m !== null && isLive(m));
  const [stored, held] = await Promise.all([
    readKey(deps.state, KEYS.awakeLog, AwakeLog),
    readKey(deps.state, KEYS.caps, CapsView),
  ]);
  const log = extendLog(stored, running, now);
  const { awake, onDemand } = countLog(log, now);
  const cfg = capConfig(deps.config.caps);
  const verdict =
    cfg === null
      ? null
      : decideAwakeCap({
          awakeMinutes: awake,
          onDemandMinutes: onDemand,
          running: running.map((m) => ({
            state: m.state,
            launchedAt: new Date(m.launchedAt).toISOString(),
            lifecycle: m.lifecycle,
          })),
          held: held === null ? null : { rule: held.rule, blocksWake: held.blocksWake },
          cfg,
          nowMs: now,
        });
  await lease.putFenced(KEYS.awakeLog, log);
  const view: CapsView = {
    at: now,
    awakeMinutes: awake,
    onDemandMinutes: onDemand,
    monthSpendUsd: held?.monthSpendUsd ?? null,
    ...(verdict === null ? {} : { rule: verdict.rule, blocksWake: verdict.blocksWake, noOnDemand: verdict.noOnDemand }),
  };
  await lease.putFenced(KEYS.caps, view);
  return verdict;
}
