// `pnpm sim`: a census over seeds, judged against known.ts. Exit 0 when every class is at or under its ceiling and
// nothing else fired. `--seed N [--trace 80]` replays one seed with its trace.
// Usage: pnpm sim [--seeds 5000] [--from 1] [--workers N] [--agent protocol|health-only] [--json]
import { parseArgs } from "node:util";
import { judgeCensus, knownClasses } from "../src/known.ts";
import { toOverrides, type SimOptions } from "../src/run.ts";
import { describeFailure, simulate } from "../src/simulate.ts";
import { census, defaultWorkers } from "./pool.ts";

const { values } = parseArgs({
  options: {
    seeds: { type: "string", default: "2000" },
    from: { type: "string", default: "1" },
    seed: { type: "string" },
    trace: { type: "string", default: "60" },
    workers: { type: "string" },
    agent: { type: "string" },
    json: { type: "boolean", default: false },
  },
});
const agent: SimOptions["agent"] =
  values.agent === "health-only" || values.agent === "protocol" ? values.agent : undefined;
const opts: SimOptions = agent === undefined ? {} : { agent };

if (values.seed !== undefined) {
  const r = simulate(Number(values.seed), toOverrides(opts));
  const tail = Number(values.trace);
  if (r.violations.length === 0 && r.errors.length === 0) {
    console.log(r.trace.slice(-tail).join("\n"));
    console.log(`seed ${r.seed}: ok (${r.wakes} wakes, awake ${Math.round(r.awakeMs / 60_000)} min)`);
  } else {
    console.log(describeFailure(r, tail));
    process.exitCode = 1;
  }
} else {
  const started = Date.now();
  const count = Number(values.seeds);
  const workers = values.workers === undefined ? defaultWorkers() : Number(values.workers);
  const { census: c, runs } = await census(Number(values.from), count, opts, workers);
  const verdict = judgeCensus(c, knownClasses());
  if (values.json) console.log(JSON.stringify({ census: c, verdict }));
  else {
    const failed = runs.filter((r) => r.findings.length > 0 || r.errors.length > 0).length;
    console.log(
      `sim: ${c.seeds} seeds, ${failed} with findings, ${c.modelErrors} model errors, ${Math.round((Date.now() - started) / 100) / 10} s`,
    );
    for (const [rule, n] of Object.entries(c.byClass).toSorted((a, b) => b[1] - a[1]))
      console.log(`  ${rule}: ${n} (seeds ${(c.examples[rule] ?? []).join(", ")})`);
    for (const e of runs.filter((r) => r.errors.length > 0).slice(0, 2))
      console.log(`  model error, seed ${e.seed}: ${e.errors[0]}`);
    console.log(verdict.ok ? "sim: verdict ok" : `sim: verdict FAIL ${JSON.stringify(verdict.over)}`);
  }
  process.exitCode = verdict.ok ? 0 : 1;
}
