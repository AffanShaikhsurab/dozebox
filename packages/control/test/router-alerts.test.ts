// C4 router: phone sinks first, email only for pages no phone sink can take; a duplicate key is not sent twice; a
// sink that fails 5 times is skipped (path verdict warn) while email never is; a crash after submit delivers on the
// next drain.
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { CLOSED, emptyLedger, type Breaker, type Ledger } from "@dozebox/core/alerts";
import { makeFakeAlertSink, makeFakeAws } from "@dozebox/testkit/fakes";
import { makeOutbox } from "../src/alerts/outbox.ts";
import { makeAlertRouter } from "../src/alerts/router.ts";
import type { Alert } from "../src/ports/alertSink.ts";

const signal = new AbortController().signal;
const down = { ok: false, retryable: true, reason: "503" } as const;

function world(sinkIds: ReadonlyArray<string> = ["ntfy", "email"]) {
  const aws = makeFakeAws();
  const sinks = sinkIds.map((id) => makeFakeAlertSink(id));
  let breakers: Readonly<Record<string, Breaker>> = {};
  let ledger: Ledger = emptyLedger();
  const outbox = makeOutbox({ state: aws.dynamodb.table, clock: aws.clock, rand: () => 0.5 });
  const router = makeAlertRouter({
    sinks,
    outbox,
    clock: aws.clock,
    breakers: { read: async () => breakers, write: async (b) => void (breakers = b) },
    ledger: { read: async () => ledger, write: async (l) => void (ledger = l) },
  });
  let n = 0;
  const alert = (over: Partial<Alert> = {}): Alert => ({
    id: `a${++n}`,
    key: `k${n}`,
    severity: "page",
    title: "Box silent",
    body: "No liveness.",
    source: "runner:judge",
    at: aws.clock.now(),
    ...over,
  });
  const sink = (id: string) => sinks.find((s) => s.id === id)!;
  return { aws, router, alert, sink, breakers: () => breakers };
}

describe("alert router", () => {
  test("a page goes to the phone sink, not email, while the phone sink works", async () => {
    const w = world();
    await w.router.submit(w.alert(), 1);
    assert.equal(await w.router.drain(signal, 1), 1);
    assert.equal(w.sink("ntfy").delivered.length, 1);
    assert.equal(w.sink("email").delivered.length, 0);
  });

  test("without a phone sink a page goes to email; a notice goes nowhere", async () => {
    const w = world(["email"]);
    await w.router.submit(w.alert(), 1);
    await w.router.submit(w.alert({ severity: "notify" }), 1);
    await w.router.drain(signal, 1);
    assert.deepEqual(
      w.sink("email").delivered.map((a) => a.severity),
      ["page"],
    );
    assert.equal((await w.router.pathVerdict()).level, "warn");
  });

  test("the same key twice in one episode is sent once", async () => {
    const w = world();
    await w.router.submit(w.alert({ key: "silent" }), 1);
    await w.router.submit(w.alert({ key: "silent" }), 1);
    await w.router.drain(signal, 1);
    assert.equal(w.sink("ntfy").delivered.length, 1);
  });

  test("a crash between submit and delivery delivers on the next drain, once", async () => {
    const w = world();
    await w.router.submit(w.alert(), 1); // the function dies here
    w.aws.clock.advance(60_000);
    await w.router.drain(signal, 2);
    await w.router.drain(signal, 3);
    assert.equal(w.sink("ntfy").delivered.length, 1);
  });

  test("5 failures open the sink's breaker: skipped, verdict warn; it is tried again after 15 min", async () => {
    const w = world();
    w.sink("ntfy").script([down, down, down, down, down]);
    for (let i = 0; i < 5; i++) {
      await w.router.submit(w.alert(), 1);
      await w.router.drain(signal, 1);
    }
    assert.equal(w.breakers()["ntfy"]?.state, "open");
    assert.deepEqual(await w.router.pathVerdict(), { level: "warn", why: "skipped: ntfy" });
    w.aws.clock.advance(15 * 60_000);
    await w.router.submit(w.alert(), 1);
    await w.router.drain(signal, 1);
    assert.deepEqual(w.breakers()["ntfy"], CLOSED);
    assert.equal((await w.router.pathVerdict()).level, "ok");
  });

  test("email is never skipped by its breaker", async () => {
    const w = world(["email"]);
    w.sink("email").script([down, down, down, down, down, down]);
    for (let i = 0; i < 6; i++) {
      await w.router.submit(w.alert(), 1);
      await w.router.drain(signal, 1);
    }
    await w.router.submit(w.alert(), 1);
    assert.ok((await w.router.drain(signal, 1)) >= 1);
  });

  test("no email sink is a failed path", async () => {
    assert.equal((await world(["ntfy"]).router.pathVerdict()).level, "fail");
  });
});
