import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Desired } from "../src/reconcile/decide.ts";
import {
  breakerOpen,
  countWakes,
  NEW_WAKE_BREAKER,
  onWakeEnd,
  WAKE_BUDGET,
  type WakeBreaker,
} from "../src/wake/budget.ts";
import { decidePark, decideWake, type WakeInput } from "../src/wake/decide.ts";
import { intentFresh, intentVoid, newestDesired } from "../src/wake/intent.ts";
import { decideNoProgress, type NoProgressInput } from "../src/wake/noProgress.ts";

const T0 = Date.UTC(2026, 10, 24, 21, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const asleep: Desired = { want: "asleep", since: T0 - HOUR, reason: "park:idle", origin: "auto" };
const input = (over: Partial<WakeInput> = {}): WakeInput => ({
  now: T0,
  origin: "person",
  desired: asleep,
  frozen: false,
  budget: { lastHour: 0, lastDay: 0, ...WAKE_BUDGET },
  ...over,
});
const open: WakeBreaker = { ...NEW_WAKE_BREAKER, failuresInRow: 3, openedAt: T0 - HOUR };

const rows: ReadonlyArray<{ name: string; input: Partial<WakeInput>; expect: unknown }> = [
  {
    name: "a person's wake on a parked box is accepted and only records desired = awake",
    input: {},
    expect: { kind: "accept", desired: { want: "awake", since: T0, reason: "wake:person", origin: "user" } },
  },
  {
    name: "a schedule wake keeps its origin",
    input: { origin: "schedule" },
    expect: { kind: "accept", desired: { want: "awake", since: T0, reason: "wake:schedule", origin: "schedule" } },
  },
  { name: "frozen refuses", input: { frozen: true }, expect: { kind: "refuse", code: "frozen" } },
  {
    name: "an awake box answers already-awake, without charging the budget",
    input: { desired: { ...asleep, want: "awake" }, budget: { lastHour: 6, lastDay: 6, ...WAKE_BUDGET } },
    expect: { kind: "already-awake" },
  },
  {
    name: "six wakes this hour refuse for an hour",
    input: { budget: { ...WAKE_BUDGET, lastHour: 6, lastDay: 6 } },
    expect: { kind: "refuse", code: "budget", retryAfterMs: HOUR },
  },
  {
    name: "24 wakes today refuse for a day",
    input: { budget: { ...WAKE_BUDGET, lastHour: 0, lastDay: 24 } },
    expect: { kind: "refuse", code: "budget", retryAfterMs: 24 * HOUR },
  },
  {
    name: "an open breaker refuses an unattended wake until it cools",
    input: { origin: "event", breaker: open },
    expect: { kind: "refuse", code: "breaker", retryAfterMs: 5 * HOUR },
  },
  {
    name: "an open breaker lets a person's wake through",
    input: { breaker: open },
    expect: { kind: "accept", desired: { want: "awake", since: T0, reason: "wake:person", origin: "user" } },
  },
  {
    name: "a cooled breaker lets an unattended wake through",
    input: { origin: "schedule", breaker: { ...open, openedAt: T0 - 7 * HOUR } },
    expect: { kind: "accept", desired: { want: "awake", since: T0, reason: "wake:schedule", origin: "schedule" } },
  },
];

for (const row of rows) {
  test(`decideWake: ${row.name}`, () => assert.deepEqual(decideWake(input(row.input)), row.expect));
}

test("decidePark always writes asleep with its time (R2, SIM-F8)", () => {
  assert.deepEqual(decidePark(T0, "user", "user"), { want: "asleep", since: T0, reason: "park:user", origin: "user" });
});

test("countWakes counts the last hour and the last day", () => {
  assert.deepEqual(countWakes([T0 - MIN, T0 - 2 * HOUR, T0 - 25 * HOUR, T0 + MIN], T0), { lastHour: 1, lastDay: 2 });
});

test("the wake breaker opens after 3 failed wakes in a row, pages once, and a served wake resets it", () => {
  let b = NEW_WAKE_BREAKER;
  const pages: boolean[] = [];
  for (const end of ["unresolved", "boot-failed", "unresolved", "unresolved"] as const) {
    const r = onWakeEnd(b, end, T0);
    pages.push(r.page);
    b = r.breaker;
  }
  assert.deepEqual(pages, [false, false, true, false]);
  assert.equal(breakerOpen(b, T0 + 5 * HOUR), true);
  assert.equal(breakerOpen(b, T0 + 6 * HOUR), false);
  const served = onWakeEnd(b, "served", T0 + HOUR).breaker;
  assert.deepEqual(served, NEW_WAKE_BREAKER);
  assert.equal(onWakeEnd(onWakeEnd(served, "unresolved", T0).breaker, "served", T0).breaker.failuresInRow, 0);
});

test("intent freshness: void when a park or a stop came after it; the same second goes to the sleep", () => {
  assert.equal(intentFresh({ now: T0, at: T0 - MIN, newestAsleepAt: null, stoppedAt: null }), true);
  assert.equal(intentFresh({ now: T0, at: T0 - 6 * MIN, newestAsleepAt: null, stoppedAt: null }), false);
  assert.equal(intentFresh({ now: T0, at: T0 - MIN, newestAsleepAt: T0 - 30_000, stoppedAt: null }), false);
  assert.equal(intentVoid({ at: T0 - MIN, newestAsleepAt: null, stoppedAt: T0 - MIN - 500 }), true);
  assert.equal(intentVoid({ at: T0 - MIN, newestAsleepAt: null, stoppedAt: T0 - 2 * MIN }), false);
  assert.equal(intentVoid({ at: T0 - MIN, newestAsleepAt: T0 - MIN, stoppedAt: null }), true);
});

test("newestDesired: the newest wins and a tie goes to asleep", () => {
  const wake: Desired = { want: "awake", since: T0, reason: "wake:person", origin: "user" };
  const park: Desired = { want: "asleep", since: T0, reason: "park:user", origin: "user" };
  assert.equal(newestDesired([]), null);
  assert.equal(newestDesired([wake, park]), park);
  assert.equal(newestDesired([park, wake]), park);
  assert.equal(newestDesired([asleep, wake]), wake);
});

const np = (over: Partial<NoProgressInput> = {}): NoProgressInput => ({
  now: T0,
  noProgressMs: 150 * MIN,
  servingSince: T0 - 200 * MIN,
  lastProgressAt: null,
  workHold: false,
  interactive: false,
  ...over,
});
const npRows: ReadonlyArray<{ name: string; input: Partial<NoProgressInput>; expect: string }> = [
  { name: "serving 200 min with no beat: park", input: {}, expect: "park" },
  {
    name: "a progress beat 100 min ago: progressing",
    input: { lastProgressAt: T0 - 100 * MIN },
    expect: "progressing",
  },
  { name: "a live work hold: progressing", input: { workHold: true }, expect: "progressing" },
  { name: "a person on the box: progressing", input: { interactive: true }, expect: "progressing" },
  { name: "not serving: nothing to judge", input: { servingSince: null }, expect: "not-serving" },
  { name: "served 149 min ago: progressing", input: { servingSince: T0 - 149 * MIN }, expect: "progressing" },
];
for (const row of npRows) {
  test(`decideNoProgress: ${row.name}`, () => assert.equal(decideNoProgress(np(row.input)).kind, row.expect));
}
