// `pnpm sim:judge`: regression detection for known bugs. The simulator, unchanged, must still find each historic bug
// when the shell re-introduces it (the legacy judge ran old git revisions; the TypeScript shell carries the old
// behaviour as `bugs`), and the current code must pass its census against known.ts.
// Usage: pnpm sim:judge [--seeds 1000] [--main-seeds 5000] [--workers N]
import { parseArgs } from "node:util";
import type { SimBug } from "../src/config.ts";
import { judgeCensus, knownClasses } from "../src/known.ts";
import { census } from "./pool.ts";

const { values } = parseArgs({
  options: {
    seeds: { type: "string", default: "1000" },
    "main-seeds": { type: "string", default: "5000" },
    workers: { type: "string" },
  },
});
const workers = values.workers === undefined ? undefined : Number(values.workers);

type Judge = {
  readonly name: string;
  readonly bug: SimBug;
  readonly why: string;
  readonly required: ReadonlyArray<string>;
};

const JUDGES: ReadonlyArray<Judge> = [
  {
    name: "W2",
    bug: "park-leaves-no-record",
    why: "a park that leaves no `desired = asleep` is undone by the older wake intent",
    required: ["sleep-undone/intent-before-sleep"],
  },
  {
    name: "D-E",
    bug: "boot-error-hidden",
    why: "a boot refused by a stale volume tag is not reported, so the box shows running",
    required: ["wake-unresolved/fallback-boot-failed", "wake-unresolved/persistent-boot-failed"],
  },
  ...(
    [
      ["agent-ignores-holds", "no-park-while-held"],
      ["agent-ignores-presence", "no-park-while-present"],
      ["agent-drops-wake-requests", "wake-request-honoured"],
      ["agent-ignores-no-progress", "progress-or-park"],
      ["agent-keeps-holds", "holds-cleared-on-boot"],
      ["agent-double-park", "one-park-per-boot"],
    ] as const
  ).map(([bug, id]) => ({ name: `S2 ${id}`, bug, why: `a broken agent (${bug})`, required: [`protocol/${id}`] })),
];

let failed = false;
for (const j of JUDGES) {
  const { census: c } = await census(1, Number(values.seeds), { bugs: [j.bug] }, workers);
  const lines = j.required.map((rule) => {
    const hits = c.byClass[rule] ?? 0;
    if (hits === 0) failed = true;
    return `     ${hits === 0 ? "MISSING" : "found  "} ${rule}: ${hits} of ${c.seeds} seeds${hits > 0 ? `, first ${c.examples[rule]?.[0]}` : ""}`;
  });
  console.log(`${lines.some((l) => l.includes("MISSING")) ? "FAIL" : "PASS"} ${j.name}: ${j.why}`);
  for (const l of lines) console.log(l);
}

const { census: main } = await census(1, Number(values["main-seeds"]), {}, workers);
const verdict = judgeCensus(main, knownClasses());
failed ||= !verdict.ok;
const classes = Object.entries(main.byClass).map(([r, n]) => `${r} ${n}`);
console.log(`${verdict.ok ? "PASS" : "FAIL"} current: ${main.seeds} seeds; ${classes.join(", ") || "no findings"}`);
for (const o of verdict.over) console.log(`     over ceiling: ${o.id} ${o.seen} > ${o.ceiling}`);
process.exitCode = failed ? 1 : 0;
