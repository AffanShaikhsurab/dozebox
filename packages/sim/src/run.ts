// S1: the simulator (port of legacy/runner/test/sim/*.mjs) on @dozebox/core: the same decision functions production
// runs, inside a simulated control shell and agent. Seeded and deterministic: one seed is one simulated box over
// `days`. Synchronous: the world is a discrete-event queue of generator processes.
import type { ConfigOverrides, SimBug } from "./config.ts";
import type { PayloadName } from "./agent/examples/names.ts";
import { knownClasses } from "./known.ts";
import { simulate } from "./simulate.ts";
import { HOUR } from "./world/clock.ts";

export type SimClassId = `SIM-F${number}`;

export type SimOptions = {
  readonly days?: number;
  /** Fault mix overrides, by config knob (`staleP`, `eventDropP`, `lambdaCrashP`, `boxKillP`, ...). Default: the legacy mix. */
  readonly faults?: Readonly<Record<string, number>>;
  /** The agent model: `protocol` (S2) or `health-only`. */
  readonly agent?: "protocol" | "health-only";
  /** The payload model (S3): `generic` (default) or the CI-driven one. */
  readonly payload?: PayloadName;
  /** Historic bugs re-introduced for the judge. */
  readonly bugs?: ReadonlyArray<SimBug>;
};

export type SimFinding = {
  readonly cls: SimClassId | "unknown";
  /** The rule string, such as `wake-unresolved/no-instance`. */
  readonly rule: string;
  readonly at: number;
  readonly detail: string;
};

export type SimRun = {
  readonly seed: number;
  readonly findings: ReadonlyArray<SimFinding>;
  readonly awakeMs: number;
  readonly wakes: number;
  /** Model errors: the simulator itself broke. Always a failure. */
  readonly errors: ReadonlyArray<string>;
};

export type Census = {
  readonly seeds: number;
  /** Seeds with at least one finding of each class, by rule string. */
  readonly byClass: Readonly<Record<string, number>>;
  /** Seeds of each class, the first few, for replay. */
  readonly examples: Readonly<Record<string, ReadonlyArray<number>>>;
  readonly modelErrors: number;
};

const FAULT_KNOBS = new Set([
  "staleP",
  "ssmLagP",
  "eventDropP",
  "eventDupP",
  "eventLateP",
  "tickDropP",
  "lambdaCrashP",
  "boxKillP",
  "reclaimOnRunningP",
  "sleepAfterReclaimP",
]);

export function toOverrides(opts: SimOptions = {}): ConfigOverrides {
  const faults: Record<string, number> = {};
  for (const [k, v] of Object.entries(opts.faults ?? {})) {
    if (!FAULT_KNOBS.has(k)) throw new Error(`unknown fault knob ${k}`);
    faults[k] = v;
  }
  return {
    ...faults,
    ...(opts.days === undefined ? {} : { horizonMs: opts.days * 24 * HOUR }),
    ...(opts.agent === undefined ? {} : { agent: opts.agent }),
    ...(opts.payload === undefined ? {} : { payload: opts.payload }),
    ...(opts.bugs === undefined ? {} : { bugs: opts.bugs }),
  };
}

export function runSeed(seed: number, opts?: SimOptions): SimRun {
  const r = simulate(seed, toOverrides(opts));
  const classes = knownClasses();
  return {
    seed,
    findings: r.violations.map((v) => ({
      cls: classes.find((c) => c.name === v.rule)?.id ?? "unknown",
      rule: v.rule,
      at: v.at,
      detail: v.message,
    })),
    awakeMs: r.awakeMs,
    wakes: r.wakes,
    errors: r.errors,
  };
}

export function censusOf(runs: ReadonlyArray<SimRun>): Census {
  const byClass: Record<string, number> = {};
  const examples: Record<string, number[]> = {};
  let modelErrors = 0;
  for (const run of runs) {
    if (run.errors.length > 0) modelErrors += 1;
    for (const rule of new Set(run.findings.map((f) => f.rule))) {
      byClass[rule] = (byClass[rule] ?? 0) + 1;
      const list = (examples[rule] ??= []);
      if (list.length < 12) list.push(run.seed);
    }
  }
  return { seeds: runs.length, byClass, examples, modelErrors };
}

export function runCensus(seeds: ReadonlyArray<number>, opts?: SimOptions): Census {
  return censusOf(seeds.map((seed) => runSeed(seed, opts)));
}
