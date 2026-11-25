// One seed: build the world, the control function and the agents, play the day, and report what the invariants saw.
// Same seed, same code: same run, byte for byte.
import { Box } from "./agent/box.ts";
import { makeConfig, type ConfigOverrides, type SimConfig } from "./config.ts";
import { Control } from "./control/control.ts";
import { createWorldInvariants, type WorldViolation } from "./invariants/world.ts";
import { createRng } from "./prng.ts";
import { schedule } from "./scenario.ts";
import { EPOCH } from "./world/clock.ts";
import { World } from "./world/world.ts";

export type SeedResult = {
  readonly seed: number;
  readonly violations: ReadonlyArray<WorldViolation>;
  readonly errors: ReadonlyArray<string>;
  readonly trace: ReadonlyArray<string>;
  readonly awakeMs: number;
  readonly wakes: number;
  readonly cfg: SimConfig;
};

export function simulate(seed: number, options: ConfigOverrides = {}): SeedResult {
  const rng = createRng(seed);
  const cfg = makeConfig(rng.fork("config"), options);
  const w = new World(rng, cfg);
  const control = new Control(w);
  w.hooks.running = (inst) => {
    const box = new Box(w, control, inst);
    w.boxes.set(inst.id, box);
    box.boot();
  };
  schedule(w, control);
  const invariants = createWorldInvariants(w, control);
  let wakes = 0;
  const previous = w.hooks.event;
  w.hooks.event = (e) => {
    previous(e);
    if (e.type === "wake") wakes += 1;
  };
  let awakeMs = 0;
  let last = w.now;
  w.run(EPOCH + cfg.horizonMs, () => {
    if (w.billing().length > 0) awakeMs += w.now - last;
    last = w.now;
    invariants.step();
  });
  if (w.errors.length === 0) invariants.finish();
  return {
    seed,
    violations: invariants.violations,
    errors: w.errors.map(
      ({ name, error }) => `${name}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    ),
    trace: w.trace,
    awakeMs,
    wakes,
    cfg,
  };
}

/** What a failing seed prints: the replay command, what broke, and the trace around the first violation. */
export function describeFailure(r: SeedResult, tail = 60): string {
  const lines = [`seed ${r.seed} failed; replay with: pnpm sim --seed ${r.seed} --trace ${tail}`];
  for (const v of r.violations) lines.push(`  VIOLATION ${v.rule}: ${v.message}`);
  for (const e of r.errors) lines.push(`  MODEL ERROR ${e}`);
  const first = r.trace.findIndex((line) => line.includes("VIOLATION") || line.includes("MODEL ERROR"));
  const from = first < 0 ? Math.max(0, r.trace.length - tail) : Math.max(0, first - tail);
  const to = first < 0 ? r.trace.length : Math.min(r.trace.length, first + 12);
  lines.push(
    `  trace (${first < 0 ? "end" : "around the first violation"}):`,
    ...r.trace.slice(from, to).map((l) => `    ${l}`),
  );
  return lines.join("\n");
}
