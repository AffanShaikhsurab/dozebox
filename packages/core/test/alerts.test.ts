// Rows ported from legacy/runner/test/control/alertrouter.node-test.ts (admitAlert, the ledger), and the sink breaker
// and routing policy of part 6 §6.3.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { allow, CLOSED, onResult, type Breaker } from "../src/alerts/breaker.ts";
import {
  admitAlert,
  emptyLedger,
  NOTICES_PER_DAY,
  NOTICES_PER_HOUR,
  parseLedger,
  pushAudit,
  type AlertMessage,
  type Ledger,
} from "../src/alerts/ledger.ts";
import { escalationsDue, routeAlert, type SinkState } from "../src/alerts/route.ts";

const T0 = Date.parse("2026-11-24T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const msg = (key: string, severity: AlertMessage["severity"], over: Partial<AlertMessage> = {}): AlertMessage => ({
  key,
  severity,
  text: key,
  ...over,
});

test("admitAlert: info is never pushed, a key is one episode, notices are limited, pages are not", () => {
  assert.equal(admitAlert(emptyLedger(), msg("a", "info"), T0).why, "info");
  const first = admitAlert(emptyLedger(), msg("n", "notify"), T0);
  assert.deepEqual([first.send, first.why], [true, "notice"]);
  assert.equal(admitAlert(first.ledger, msg("n", "notify"), T0 + MIN).why, "duplicate");
  assert.equal(admitAlert(first.ledger, msg("n", "notify"), T0 + 13 * HOUR).why, "notice");
  let ledger: Ledger = emptyLedger();
  const whys: string[] = [];
  for (let i = 0; i <= NOTICES_PER_HOUR; i += 1) {
    const r = admitAlert(ledger, msg(`k${i}`, "notify"), T0 + i * 1000);
    whys.push(r.why);
    ledger = r.ledger;
  }
  assert.equal(whys.at(-1), "rate-limited");
  assert.equal(admitAlert(ledger, msg("p", "page"), T0 + 10_000).why, "page");
  let day: Ledger = emptyLedger();
  for (let i = 0; i < NOTICES_PER_DAY; i += 1) day = admitAlert(day, msg(`d${i}`, "notify"), T0 + i * 11 * MIN).ledger;
  assert.equal(admitAlert(day, msg("late", "notify"), T0 + NOTICES_PER_DAY * 11 * MIN).why, "rate-limited");
});

test("admitAlert: a page stays one decision until it resolves, and the badge counts open decisions", () => {
  const page = admitAlert(emptyLedger(), msg("stuck", "page"), T0);
  assert.equal(page.badge, 1);
  assert.equal(admitAlert(page.ledger, msg("stuck", "page"), T0 + 13 * HOUR).why, "duplicate");
  const resolved = admitAlert(page.ledger, msg("back", "info", { resolves: ["stuck"] }), T0 + MIN);
  assert.equal(resolved.badge, 0);
  assert.deepEqual(resolved.ledger.pending, []);
});

test("parseLedger survives junk, and pushAudit counts the daily counters", () => {
  assert.deepEqual(parseLedger("not json"), emptyLedger());
  assert.deepEqual(parseLedger('{"v":2}'), emptyLedger());
  const parsed = parseLedger(
    JSON.stringify({
      v: 1,
      keys: { a: { at: T0, sev: "p", open: 1 }, b: { at: "x", sev: "p" } },
      notices: [T0, "x"],
      pending: [{ key: "a", at: T0, text: "t" }, { key: 1 }],
      days: { "2026-11-24": [3, 1], junk: [1, 1] },
    }),
  );
  assert.deepEqual(Object.keys(parsed.keys), ["a"]);
  assert.deepEqual(parsed.notices, [T0]);
  assert.equal(parsed.pending.length, 1);
  assert.deepEqual(pushAudit(parsed, T0), { pushes: 3, pages: 1 });
});

test("the sink breaker opens after 5 failures, skips for 15 minutes, then tries once", () => {
  let b: Breaker = CLOSED;
  for (let i = 0; i < 4; i += 1) b = onResult(b, false, T0);
  assert.equal(b.state, "closed");
  b = onResult(b, false, T0);
  assert.deepEqual(b, { state: "open", failures: 5, openedAt: T0 });
  assert.equal(allow(b, T0 + 14 * MIN), null);
  const half = allow(b, T0 + 15 * MIN);
  assert.equal(half?.state, "half-open");
  assert.equal(onResult(half as Breaker, false, T0 + 15 * MIN).state, "open");
  assert.deepEqual(onResult(half as Breaker, true, T0 + 15 * MIN), CLOSED);
  assert.equal(allow(CLOSED, T0), CLOSED);
});

const open: Breaker = { state: "open", failures: 5, openedAt: T0 };
const sinks = (ntfy: Breaker = CLOSED, email: Breaker = open): SinkState[] => [
  { name: "ntfy", lastResort: false, breaker: ntfy },
  { name: "email", lastResort: true, breaker: email },
];

test("routeAlert: phone sinks take pages and notices; info goes nowhere", () => {
  assert.deepEqual(
    routeAlert("page", sinks(), T0).deliver.map((d) => d.sink),
    ["ntfy"],
  );
  assert.deepEqual(
    routeAlert("notify", sinks(), T0).deliver.map((d) => d.sink),
    ["ntfy"],
  );
  assert.deepEqual(routeAlert("info", sinks(), T0), { deliver: [], skipped: [], pathLevel: "ok" });
});

test("routeAlert: a skipped phone sink turns the path warn; a page then goes to email, never skipped", () => {
  const r = routeAlert("page", sinks(open, open), T0 + MIN);
  assert.deepEqual(
    r.deliver.map((d) => d.sink),
    ["email"],
  );
  assert.deepEqual(r.skipped, ["ntfy"]);
  assert.equal(r.pathLevel, "warn");
  assert.deepEqual(routeAlert("notify", sinks(open), T0 + MIN), { deliver: [], skipped: ["ntfy"], pathLevel: "warn" });
  assert.deepEqual(routeAlert("notify", [], T0), { deliver: [], skipped: [], pathLevel: "warn" });
});

test("escalationsDue: pages without a phone receipt after 10 minutes go to email", () => {
  const pending = [
    { key: "a", text: "a", at: T0 - 11 * MIN },
    { key: "b", text: "b", at: T0 - 11 * MIN },
    { key: "c", text: "c", at: T0 - 5 * MIN },
  ];
  assert.deepEqual(
    escalationsDue(pending, new Set(["b"]), T0).map((p) => p.key),
    ["a"],
  );
});
