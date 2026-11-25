// Awake hours and On-Demand hours from EC2 state history (part 13 WP-K4): the time any machine of the box ran in the
// rolling window. Overlaps count once, so a reclaim hand-off (old and new machine both running) is not billed twice
// against the cap, the same rule the legacy hourly buckets applied.
import { DAY, MINUTE } from "../time/index.ts";

export type StateChange = { readonly at: number; readonly state: string };
export type MachineHistory = {
  readonly id: string;
  readonly lifecycle: "spot" | "on-demand";
  /** State changes in any order. The state before the first one is `stateBefore` (default: not running). */
  readonly changes: ReadonlyArray<StateChange>;
  readonly stateBefore?: string;
};
export type Interval = { readonly from: number; readonly to: number };

/** The intervals a machine was `running`, clipped to [from, to]. */
export function runningIntervals(m: MachineHistory, from: number, to: number): Interval[] {
  const changes = m.changes.toSorted((a, b) => a.at - b.at);
  const out: Interval[] = [];
  let since: number | null = m.stateBefore === "running" ? from : null;
  for (const c of changes) {
    if (c.at > to) break;
    if (c.state === "running") since ??= Math.max(c.at, from);
    else if (since !== null) {
      if (c.at > since) out.push({ from: since, to: c.at });
      since = null;
    }
  }
  if (since !== null && to > since) out.push({ from: since, to });
  return out.filter((i) => i.to > i.from);
}

/** Total length of the union of intervals. */
export function unionMs(intervals: ReadonlyArray<Interval>): number {
  let total = 0;
  let end = Number.NEGATIVE_INFINITY;
  for (const i of intervals.toSorted((a, b) => a.from - b.from)) {
    if (i.to <= end) continue;
    total += i.to - Math.max(i.from, end);
    end = i.to;
  }
  return total;
}

export type AwakeCount = { readonly awakeMinutes: number; readonly onDemandMinutes: number };

/** Minutes awake (any machine) and On-Demand (On-Demand machines only) in the window ending at `now`. */
export function countAwake(machines: ReadonlyArray<MachineHistory>, now: number, windowMs = DAY): AwakeCount {
  const from = now - windowMs;
  const all: Interval[] = [];
  const od: Interval[] = [];
  for (const m of machines) {
    const intervals = runningIntervals(m, from, now);
    all.push(...intervals);
    if (m.lifecycle === "on-demand") od.push(...intervals);
  }
  return { awakeMinutes: Math.round(unionMs(all) / MINUTE), onDemandMinutes: Math.round(unionMs(od) / MINUTE) };
}
