// The knobs of one seed (port of legacy scenario.mjs makeConfig, same draws in the same order): a person who wakes
// and sleeps the box, Spot reclaims, payload faults, a capacity outage, a volume tagged active=false, and how badly
// AWS misbehaves. Drawn from the seed, never from the code under test.
import { HOUR, MINUTE } from "./world/clock.ts";
import { MEASURED as M } from "./measured.ts";
import type { Rng } from "./prng.ts";

/** Historic bugs the judge re-introduces to prove the simulator still finds them (part 10 §10.7). */
export type SimBug =
  /** W2: a park does not write `desired = asleep`, so an older wake intent undoes a sleep. */
  | "park-leaves-no-record"
  /** D-E: a boot refused by a stale volume tag is not reported, so the box shows running. */
  | "boot-error-hidden";

type Window = readonly [number, number];

export type SimConfig = {
  readonly horizonMs: number;
  readonly settleMs: number;
  readonly idleMinutes: number;
  readonly staleP: number;
  readonly staleMaxMs: number;
  readonly ssmLagP: number;
  readonly ssmLagMs: number;
  readonly eventDropP: number;
  readonly eventDupP: number;
  readonly eventLateP: number;
  readonly tickDropP: number;
  readonly lambdaCrashP: number;
  readonly boxKillP: number;
  readonly capacityWindows: Window[];
  readonly wakes: ReadonlyArray<number>;
  readonly userSleeps: ReadonlyArray<number>;
  readonly reclaims: ReadonlyArray<number>;
  readonly reclaimOnRunningP: number;
  readonly sleepAfterReclaimP: number;
  readonly serverFaults: ReadonlyArray<number>;
  readonly tagWindows: Window[];
  readonly bugs: ReadonlyArray<SimBug>;
  /** `protocol`: the payload holds the box while it works, beats and leaves wakes (S2). */
  readonly agent: "protocol" | "health-only";
};

export type ConfigOverrides = Partial<Omit<SimConfig, "capacityWindows" | "tagWindows">> & {
  readonly capacityWindows?: Window[];
  readonly tagWindows?: Window[];
};

const someTimes = (r: Rng, count: number, from: number, to: number): number[] =>
  Array.from({ length: count }, () => r.int(from, to)).toSorted((a, b) => a - b);

export function makeConfig(r: Rng, options: ConfigOverrides = {}): SimConfig {
  const horizonMs = options.horizonMs ?? 24 * HOUR;
  const settleMs = 3 * HOUR;
  const mostly = (zeroP: number, hi: number): number => (r.chance(zeroP) ? 0 : r.next() * hi);
  const drawn = {
    horizonMs,
    settleMs,
    idleMinutes: M.idleMinutes,
    staleP: mostly(0.35, 0.6),
    staleMaxMs: M.staleReadMaxMs,
    ssmLagP: mostly(0.8, 0.3),
    ssmLagMs: M.ssmLagMs,
    eventDropP: mostly(0.4, 0.3),
    eventDupP: mostly(0.5, 0.4),
    eventLateP: mostly(0.5, 0.4),
    tickDropP: mostly(0.5, 0.05),
    lambdaCrashP: mostly(0.4, 0.15),
    boxKillP: mostly(0.6, 0.08),
    capacityWindows: [] as Window[],
    wakes: someTimes(r, r.int(3, 9), MINUTE, horizonMs - settleMs),
    userSleeps: someTimes(r, r.int(1, 6), 5 * MINUTE, horizonMs - settleMs),
    reclaims: r.chance(0.3) ? [] : someTimes(r, r.int(1, 8), 10 * MINUTE, horizonMs - settleMs),
    reclaimOnRunningP: mostly(0.4, 0.5),
    sleepAfterReclaimP: mostly(0.3, 0.8),
    serverFaults: r.chance(0.5) ? [] : someTimes(r, r.int(1, 4), 20 * MINUTE, horizonMs - settleMs),
    tagWindows: [] as Window[],
    bugs: [] as SimBug[],
    agent: "protocol" as const,
  };
  const cfg: SimConfig = { ...drawn, ...options };
  if (!options.capacityWindows) {
    for (let i = r.chance(0.5) ? r.int(1, 3) : 0; i > 0; i -= 1) {
      const from = r.int(0, horizonMs - settleMs);
      cfg.capacityWindows.push([from, from + r.int(2 * MINUTE, 25 * MINUTE)]);
    }
  }
  if (!options.tagWindows) {
    for (let i = r.chance(0.4) ? r.int(1, 2) : 0; i > 0; i -= 1) {
      const from = r.int(0, horizonMs - settleMs);
      const window: Window = [from, from + r.int(15 * MINUTE, 90 * MINUTE)];
      cfg.tagWindows.push(window);
      // The D-E drill: the persistent instance cannot start, so the fallback boots against the wrongly tagged volume.
      if (r.chance(0.4)) cfg.capacityWindows.push([...window]);
    }
  }
  return cfg;
}
