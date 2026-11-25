import { strict as assert } from "node:assert";
import { test } from "node:test";
import { idleVerdict, type IdleInputs } from "../src/idle/verdict.ts";

const T0 = Date.UTC(2026, 10, 24, 21, 0, 0);
const MIN = 60_000;
const base: IdleInputs = {
  now: T0,
  idleMs: 30 * MIN,
  viewingGraceMs: 10 * MIN,
  servingSince: T0 - 60 * MIN,
  holds: [],
  presence: [],
  lastInteractiveAt: null,
  lastProgressAt: null,
  lastActivityAt: null,
};

// Part 10 §10.4, then the rows the rules of part 4 §4.6, §4.7 and §4.16 add.
const rows: ReadonlyArray<{ name: string; input: Partial<IdleInputs>; expect: "awake" | "idle" }> = [
  { name: "nothing for an hour -> idle", input: {}, expect: "idle" },
  {
    name: "live work hold -> awake",
    input: { holds: [{ key: "p/run", kind: "work", until: T0 + MIN }] },
    expect: "awake",
  },
  {
    name: "hold expired 31 min ago -> idle",
    input: { holds: [{ key: "p/run", kind: "work", until: T0 - 31 * MIN }] },
    expect: "idle",
  },
  {
    name: "viewing with input 5 min ago -> awake",
    input: { presence: [{ key: "p/tab", kind: "viewing", until: T0 + MIN }], lastInteractiveAt: T0 - 5 * MIN },
    expect: "awake",
  },
  { name: "progress beat 29 min ago -> awake", input: { lastProgressAt: T0 - 29 * MIN }, expect: "awake" },
  { name: "health-only activity 31 min ago -> idle", input: { lastActivityAt: T0 - 31 * MIN }, expect: "idle" },
  {
    name: "live wait hold -> awake",
    input: { holds: [{ key: "p/ci", kind: "wait", until: T0 + MIN }] },
    expect: "awake",
  },
  {
    name: "hold expired 29 min ago -> awake (recent activity)",
    input: { holds: [{ key: "p/run", kind: "work", until: T0 - 29 * MIN }] },
    expect: "awake",
  },
  {
    name: "interactive presence -> awake without input",
    input: { presence: [{ key: "src:ssh", kind: "interactive", until: T0 + MIN }] },
    expect: "awake",
  },
  {
    name: "a viewing tab renewed forever without input -> idle 30 min after the grace",
    input: {
      presence: [{ key: "p/tab", kind: "viewing", until: T0 + MIN }],
      lastInteractiveAt: T0 - 40 * MIN,
      servingSince: T0 - 90 * MIN,
    },
    expect: "idle",
  },
  {
    name: "a viewing tab with no input ever -> idle",
    input: { presence: [{ key: "p/tab", kind: "viewing", until: T0 + MIN }] },
    expect: "idle",
  },
  {
    name: "expired presence does not count",
    input: { presence: [{ key: "src:ssh", kind: "interactive", until: T0 - 40 * MIN }] },
    expect: "idle",
  },
  { name: "served 29 min ago -> awake", input: { servingSince: T0 - 29 * MIN }, expect: "awake" },
  { name: "never served, nothing else -> idle from epoch", input: { servingSince: null }, expect: "idle" },
  { name: "exactly idleMs since the last activity -> idle", input: { lastProgressAt: T0 - 30 * MIN }, expect: "idle" },
];

for (const row of rows) {
  test(`idleVerdict: ${row.name}`, () => {
    assert.equal(idleVerdict({ ...base, ...row.input }).kind, row.expect);
  });
}

test("idleVerdict names every live hold and counted presence, and the idle time", () => {
  const awake = idleVerdict({
    ...base,
    holds: [
      { key: "p/run", kind: "work", until: T0 + MIN },
      { key: "p/old", kind: "work", until: T0 - MIN },
    ],
    presence: [
      { key: "src:ssh", kind: "interactive", until: T0 + MIN },
      { key: "p/tab", kind: "viewing", until: T0 + MIN },
    ],
  });
  assert.deepEqual(awake, { kind: "awake", because: ["hold:p/run", "presence:src:ssh"] });
  assert.deepEqual(idleVerdict({ ...base, lastProgressAt: T0 - 45 * MIN }), {
    kind: "idle",
    since: T0 - 45 * MIN,
    sleepAt: T0 - 15 * MIN,
  });
  assert.deepEqual(idleVerdict({ ...base, lastProgressAt: T0 - 10 * MIN }), {
    kind: "awake",
    because: ["recent-activity"],
  });
});

test("idleVerdict property: a newer activity never turns awake into idle", () => {
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let i = 0; i < 500; i += 1) {
    const at = T0 - rand(120) * MIN;
    const input: IdleInputs = { ...base, lastProgressAt: at, lastActivityAt: T0 - rand(120) * MIN };
    const before = idleVerdict(input).kind;
    const later = idleVerdict({ ...input, lastProgressAt: at + rand(60) * MIN }).kind;
    if (before === "awake") assert.equal(later, "awake", `row ${i}`);
  }
});
