// POST /v1/wake and POST /v1/park: they write the desired state and never call a Compute action (R1, SIM-F5);
// 429 with Retry-After on the wake budget and the breaker; 423 when frozen; a park is always written (R2).
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { ControlAnswer, ControlErrorBody } from "@dozebox/protocol/control";
import Value from "typebox/value";
import type { FunctionUrlResult } from "../src/http/event.ts";
import { KEYS } from "../src/state/keys.ts";
import { body, makeWorld, ROOT, type World } from "./fixture.ts";

const HOUR = 3_600_000;
const actions = (w: World) => w.computeCalls.filter((c) => !c.op.startsWith("describe"));

async function wakeThenPark(w: World, times: number) {
  for (let i = 0; i < times; i++) {
    assert.equal(body(await w.call("POST", "/v1/wake")).decision, "accept");
    w.aws.clock.advance(1_000);
    await w.call("POST", "/v1/park");
    w.aws.clock.advance(1_000);
  }
}

describe("wake", () => {
  test("accept writes desired = awake, answers 202 ControlAnswer, and calls no Compute action", async () => {
    const w = makeWorld();
    w.aws.ec2.addMachine({ boxId: "main", role: "persistent", state: "stopped", lifecycle: "spot" });
    const res = await w.call("POST", "/v1/wake", { headers: { "idempotency-key": "run-1" } });
    assert.equal(res.statusCode, 202);
    assert.ok(Value.Check(ControlAnswer, res.json));
    assert.deepEqual([body(res).decision, body(res).desired, body(res).state], ["accept", "awake", "launching"]);
    const stored = await w.deps.desired.read();
    assert.deepEqual(stored, { want: "awake", since: w.aws.clock.now(), reason: "wake:person", origin: "user" });
    assert.deepEqual(actions(w), []);
    assert.deepEqual(w.aws.ec2.calls, []);
    assert.deepEqual(w.aws.asg.calls, []);
    assert.ok(w.lines.some((l) => l.includes('"WakeAccepted":1')));
  });

  test("a wake while desired is awake is already-awake and writes nothing", async () => {
    const w = makeWorld();
    await w.call("POST", "/v1/wake");
    const first = await w.deps.desired.read();
    w.aws.clock.advance(5_000);
    const res = await w.call("POST", "/v1/wake");
    assert.equal(res.statusCode, 202);
    assert.equal(body(res).decision, "already-awake");
    assert.deepEqual(await w.deps.desired.read(), first);
    assert.equal((await w.deps.wakeLedger.read(w.aws.clock.now())).length, 1);
  });

  test("the seventh wake in an hour is 429 wake_budget with Retry-After", async () => {
    const w = makeWorld();
    await wakeThenPark(w, 6);
    const res = await w.call("POST", "/v1/wake");
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers["retry-after"], "3600");
    assert.ok(Value.Check(ControlErrorBody, res.json));
    assert.deepEqual(body(res).error, {
      code: "wake_budget",
      message: "The wake budget is used up; try again later.",
      retryable: true,
      retryAfterSeconds: 3600,
    });
    assert.equal((await w.deps.desired.read()).want, "asleep");
    w.aws.clock.advance(HOUR);
    assert.equal((await w.call("POST", "/v1/wake")).statusCode, 202);
  });

  test("the configured budget applies (DOZEBOX_CONTROL.wakeBudget)", async () => {
    const w = makeWorld({ config: { wakeBudget: { perHour: 1, perDay: 24 } } });
    await wakeThenPark(w, 1);
    assert.equal((await w.call("POST", "/v1/wake")).statusCode, 429);
  });

  test("frozen is 423 frozen and writes nothing, for a wake and for an already-awake box", async () => {
    const w = makeWorld();
    await w.call("POST", "/v1/wake");
    const before = await w.deps.desired.read();
    await w.deps.records.put("freeze", JSON.stringify({ v: 1, frozen: true, by: "kill", reason: "kill-awake" }), {
      tier: "Standard",
    });
    const res = await w.call("POST", "/v1/wake");
    assert.equal(res.statusCode, 423);
    assert.deepEqual(body(res).error, {
      code: "frozen",
      message: "The box is frozen; run unfreeze first.",
      retryable: false,
    });
    assert.equal(res.headers["retry-after"], undefined);
    assert.deepEqual(await w.deps.desired.read(), before);
    const status = body(await w.call("GET", "/v1/status"));
    assert.equal(status.frozen, true);
    assert.deepEqual((status.summary as { actions: unknown }).actions, ["unfreeze"]);
  });

  test("an unattended wake is refused while the breaker is open; a person's wake passes", async () => {
    const w = makeWorld();
    const now = w.aws.clock.now();
    await w.deps.state.putFenced(
      KEYS.wakeBreaker,
      { failuresInRow: 3, openedAt: now, threshold: 3, coolMs: 6 * HOUR },
      1,
    );
    w.aws.clock.advance(HOUR);
    const auto = await w.call("POST", "/v1/wake", { query: "origin=auto" });
    assert.equal(auto.statusCode, 429);
    assert.equal(auto.headers["retry-after"], String(5 * 3600));
    assert.equal((body(auto).error as { code: string }).code, "wake_breaker");
    const person = await w.call("POST", "/v1/wake", { query: "origin=user" });
    assert.equal(person.statusCode, 202);
  });

  test("bad Idempotency-Key or origin is 400 bad_request", async () => {
    const w = makeWorld();
    for (const key of ["", "x".repeat(65), "has space"]) {
      const res = await w.call("POST", "/v1/wake", { headers: { "idempotency-key": key } });
      assert.equal(res.statusCode, 400, JSON.stringify(key));
    }
    assert.equal((await w.call("POST", "/v1/wake", { query: "origin=robot" })).statusCode, 400);
    assert.equal((await w.deps.desired.read()).want, "asleep");
  });

  test("Idempotency-Key goes through the idempotency seam: a remembered answer is returned as it is", async () => {
    const stored = new Map<string, FunctionUrlResult>();
    const w = makeWorld({
      idempotency: { recall: async (k) => stored.get(k) ?? null, remember: async (k, a) => void stored.set(k, a) },
    });
    const first = await w.call("POST", "/v1/wake", { headers: { "idempotency-key": "run-1" } });
    w.aws.clock.advance(1_000);
    const again = await w.call("POST", "/v1/wake", { headers: { "idempotency-key": "run-1" } });
    assert.equal(again.body, first.body);
    assert.equal(body(again).decision, "accept");
    assert.equal((await w.deps.wakeLedger.read(w.aws.clock.now())).length, 1);
    const other = await w.call("POST", "/v1/wake", { headers: { "idempotency-key": "run-2" } });
    assert.equal(body(other).decision, "already-awake");
  });
});

describe("park", () => {
  test("park writes desired = asleep even when nothing runs, and calls no Compute action", async () => {
    const w = makeWorld();
    const res = await w.call("POST", "/v1/park");
    assert.equal(res.statusCode, 202);
    assert.ok(Value.Check(ControlAnswer, res.json));
    assert.deepEqual([body(res).decision, body(res).desired, body(res).state], ["accept", "asleep", "parked"]);
    assert.deepEqual(await w.deps.desired.read(), {
      want: "asleep",
      since: w.aws.clock.now(),
      reason: "park:user",
      origin: "user",
    });
    assert.deepEqual(actions(w), []);
  });

  test("a park voids the wake before it; a wake in the same millisecond as a park loses (R2)", async () => {
    const w = makeWorld();
    w.aws.ec2.addMachine({ boxId: "main", role: "persistent", state: "running", lifecycle: "spot" });
    await w.call("POST", "/v1/wake");
    const parked = await w.call("POST", "/v1/park");
    assert.deepEqual([body(parked).desired, body(parked).state], ["asleep", "running"]);
    const raced = await w.deps.desired.write({ want: "awake", since: w.aws.clock.now(), reason: "x", origin: "user" });
    assert.equal(raced, "older");
    assert.equal((await w.deps.desired.read()).want, "asleep");
    assert.deepEqual(actions(w), []);
  });

  test("the desired state is the state table item kv#desired", async () => {
    const w = makeWorld();
    await w.call("POST", "/v1/park");
    const item = w.aws.dynamodb.items().get("kv#desired");
    assert.equal(item?.fencing, w.aws.clock.now() * 2 + 1);
    assert.equal([...w.aws.ssm.parameters().keys()].filter((k) => k.startsWith(ROOT)).length, 0);
  });
});
