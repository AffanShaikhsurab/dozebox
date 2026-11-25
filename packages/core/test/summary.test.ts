// The summary text from the config's brand and copy (part 5 §5.3), with the held-cap rows of the legacy capsSummaryRow.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { composeSummary, type SummaryInput } from "../src/summary/compose.ts";

const T0 = Date.parse("2026-11-24T12:00:00.000Z");
const input = (over: Partial<SummaryInput> = {}): SummaryInput => ({
  now: T0,
  state: "parked",
  brand: { name: "Acme box" },
  cap: null,
  ...over,
});

const rows: ReadonlyArray<{
  name: string;
  input: Partial<SummaryInput>;
  expect: Partial<ReturnType<typeof composeSummary>>;
}> = [
  {
    name: "parked names the brand and offers wake",
    input: {},
    expect: { level: "info", headline: "Acme box is asleep", actions: ["wake"] },
  },
  {
    name: "launching offers park",
    input: { state: "launching" },
    expect: { level: "info", headline: "Acme box is waking", actions: ["park"] },
  },
  { name: "running and idle", input: { state: "running" }, expect: { level: "ok", headline: "Acme box is awake" } },
  {
    name: "running and busy",
    input: { state: "running", busyPayloads: 1 },
    expect: { level: "ok", headline: "Working", detail: "1 payload busy." },
  },
  { name: "waiting for capacity warns", input: { state: "waiting-capacity" }, expect: { level: "warn" } },
  {
    name: "replacing",
    input: { state: "replacing" },
    expect: { level: "info", headline: "Moving Acme box to a new machine" },
  },
  {
    name: "stopped with an error shows it",
    input: { state: "stopped-error", lastError: { message: "attach refused" } },
    expect: { level: "bad", detail: "attach refused", actions: ["wake"] },
  },
  {
    name: "frozen by a budget",
    input: { cap: { rule: "frozen", blocksWake: true, frozenBy: "monthly" } },
    expect: { level: "bad", headline: "Frozen: monthly reached its limit.", actions: ["unfreeze"] },
  },
  {
    name: "frozen by an alarm",
    input: { cap: { rule: "native", blocksWake: true, alarm: "box-awake-sum" } },
    expect: { level: "bad", headline: "Frozen by AWS: box-awake-sum.", next: "Wakes again when the cap clears." },
  },
  {
    name: "awake cap with a wake time",
    input: { cap: { rule: "awake-24h", blocksWake: true, awakeMinutes: 990, wakesAt: "2026-11-24T20:00:00.000Z" } },
    expect: {
      level: "warn",
      headline: "Paused: awake limit (16.5 h in 24 h).",
      next: "Wakes again at 2026-11-24T20:00:00.000Z.",
      actions: ["keep-awake-past-limit"],
    },
  },
  {
    name: "a cap that does not block wakes does not take over",
    input: { state: "running", cap: { rule: "per-wake", blocksWake: false } },
    expect: { headline: "Acme box is awake" },
  },
  {
    name: "copy overrides the words, placeholders still filled",
    input: { copy: { parked: "{brand} sleeps ({unknown})" } },
    expect: { headline: "Acme box sleeps ({unknown})" },
  },
];

for (const row of rows) {
  test(`composeSummary: ${row.name}`, () => {
    const s = composeSummary(input(row.input));
    const picked = Object.fromEntries(Object.keys(row.expect).map((k) => [k, s[k as keyof typeof s]]));
    assert.deepEqual(picked, row.expect);
  });
}
