// logShipLoop: ship and advance, redact, daily budget, new UTC day, send failure keeps the cursor.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { LogEvent } from "../src/ports/logs.ts";
import { LOG_SHIP_MS, logShipLoop, type ShipperState } from "../src/logs/index.ts";

const DAY1 = Date.parse("2026-11-25T23:59:50.000Z");
const ev = (message: string, at = 1): LogEvent => ({ at, message });
const size = (m: string) => Buffer.byteLength(m, "utf8") + 26;

function setup(opts: { readonly budgetBytes?: number } = {}) {
  let now = DAY1;
  const journal: Array<{ cursor: string; event: LogEvent }> = [];
  const sent: LogEvent[][] = [];
  const budget: ShipperState[] = [];
  const reads: Array<string | null> = [];
  const state = { failSend: false };
  const loop = logShipLoop({
    transport: {
      send: async (_g, _s, events) => {
        if (state.failSend) throw new Error("cw down");
        sent.push([...events]);
        return events.length;
      },
    },
    group: "g",
    stream: "s",
    read: async (cursor, max) => {
      reads.push(cursor);
      const from = cursor === null ? 0 : journal.findIndex((j) => j.cursor === cursor) + 1;
      const part = journal.slice(from, from + max);
      return { events: part.map((p) => p.event), cursor: part.at(-1)?.cursor ?? cursor };
    },
    now: () => now,
    onBudget: (s) => budget.push(s),
    ...opts,
  });
  const add = (...messages: string[]) =>
    messages.forEach((m) => journal.push({ cursor: `c${journal.length + 1}`, event: ev(m) }));
  return { loop, add, sent, budget, reads, state, setNow: (t: number) => void (now = t) };
}

const signal = new AbortController().signal;

test("the loop is named logs and runs every LOG_SHIP_MS, not immediately", () => {
  const s = setup();
  assert.equal(s.loop.name, "logs");
  assert.equal(s.loop.everyMs, LOG_SHIP_MS);
  assert.equal(s.loop.immediate, false);
});

test("a tick ships new lines and advances the cursor", async () => {
  const s = setup();
  s.add("a", "b");
  await s.loop.tick(signal);
  assert.deepEqual(s.sent, [[ev("a"), ev("b")]]);
  s.add("c");
  await s.loop.tick(signal);
  assert.deepEqual(s.sent[1], [ev("c")]);
  assert.deepEqual(s.reads, [null, "c2"]);
  await s.loop.tick(signal);
  assert.equal(s.sent.length, 2);
});

test("messages are redacted before they ship", async () => {
  const s = setup();
  s.add("login as jane@example.com from /home/ubuntu");
  await s.loop.tick(signal);
  assert.equal(s.sent[0]?.[0]?.message, "login as [redacted] from /home/[redacted]");
});

test("crossing the daily budget calls onBudget once, drops the rest, and still advances", async () => {
  const s = setup({ budgetBytes: size("aaaa") * 2 });
  s.add("aaaa", "bbbb", "cccc", "dddd");
  await s.loop.tick(signal);
  assert.deepEqual(
    s.sent[0]?.map((e) => e.message),
    ["aaaa", "bbbb"],
  );
  assert.equal(s.budget.length, 1);
  assert.equal(s.budget[0]?.day, "2026-11-25");
  assert.equal(s.budget[0]?.cursor, "c4");
  s.add("eeee");
  await s.loop.tick(signal);
  assert.equal(s.sent.length, 1);
  assert.equal(s.budget.length, 1);
  assert.deepEqual(s.reads, [null, "c4"]);
});

test("the next UTC day resets the budget and can alert again", async () => {
  const s = setup({ budgetBytes: size("aaaa") });
  s.add("aaaa", "bbbb");
  await s.loop.tick(signal);
  assert.equal(s.budget.length, 1);
  s.setNow(Date.parse("2026-11-26T00:00:05.000Z"));
  s.add("cccc", "dddd");
  await s.loop.tick(signal);
  assert.deepEqual(
    s.sent.map((b) => b.map((e) => e.message)),
    [["aaaa"], ["cccc"]],
  );
  assert.equal(s.budget.length, 2);
  assert.equal(s.budget[1]?.day, "2026-11-26");
});

test("a send failure throws and keeps the cursor, so the same lines go next tick", async () => {
  const s = setup();
  s.add("a", "b");
  s.state.failSend = true;
  await assert.rejects(s.loop.tick(signal), /cw down/);
  s.state.failSend = false;
  await s.loop.tick(signal);
  assert.deepEqual(s.reads, [null, null]);
  assert.deepEqual(s.sent, [[ev("a"), ev("b")]]);
});
