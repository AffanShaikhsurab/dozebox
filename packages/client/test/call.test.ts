import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createClient, DozeboxError } from "../src/index.ts";
import { makeClient } from "../src/client.ts";
import { errorBody, noDelay, reply, startFake } from "./fake.ts";

const at = "2026-11-24T21:00:00.000Z";
const hold = { id: "run-1", reason: "r", kind: "work", since: at, requestedUntil: at, until: at, clamped: false };
const status = {
  box: {
    id: "main",
    phase: "serving",
    since: at,
    instance: { id: "i-1", type: "m7g.xlarge", az: "us-east-1a", lifecycle: "spot" },
    bootedAt: at,
    memoryBytes: 1,
    cpus: 4,
    controlUrl: null,
  },
  jail: { ready: true, egress: "imds-only", missing: [] },
  idle: { since: null, sleepAt: null, awakeBecause: [] },
  disk: { level: "ok", freePct: 61.5, freeBytes: 1, at },
  caps: { awakeSecondsToday: 0, awakeSecondsCap: null },
  holds: [],
  wakes: [],
};

test("a non-retryable 4xx is called once", async (t) => {
  const fake = await startFake(t, (_req, res) => reply(res, 400, errorBody("invalid_value", false)));
  const client = makeClient({ socketPath: fake.socketPath, delay: noDelay });
  await assert.rejects(
    client.hold("run-1", { reason: "r", until: at }),
    (e) => e instanceof DozeboxError && e.code === "invalid_value" && e.status === 400 && !e.retryable,
  );
  assert.equal(fake.seen.length, 1);
});

test("a retryable 503 is retried until it succeeds", async (t) => {
  let n = 0;
  const fake = await startFake(t, (_req, res) =>
    ++n < 3 ? reply(res, 503, errorBody("shutting_down", true)) : reply(res, 200, hold),
  );
  const delays: number[] = [];
  const client = makeClient({
    socketPath: fake.socketPath,
    delay: async (attempt) => void delays.push(attempt),
  });
  assert.equal((await client.hold("run-1", { reason: "r", until: at })).id, "run-1");
  assert.equal(fake.seen.length, 3);
  assert.deepEqual(delays, [1, 2]);
});

test("a 5xx without a body is retried, and gives up after the attempts", async (t) => {
  const fake = await startFake(t, (_req, res) => reply(res, 502));
  const client = makeClient({ socketPath: fake.socketPath, delay: noDelay, attempts: 3 });
  await assert.rejects(client.status(), (e) => e instanceof DozeboxError && e.status === 502 && e.retryable);
  assert.equal(fake.seen.length, 3);
});

test("an error body that says retryable: false stops a 5xx", async (t) => {
  const fake = await startFake(t, (_req, res) => reply(res, 500, errorBody("internal", false)));
  const client = makeClient({ socketPath: fake.socketPath, delay: noDelay });
  await assert.rejects(client.status(), DozeboxError);
  assert.equal(fake.seen.length, 1);
});

test("a call that gets no answer fails with code transport after retries", async (t) => {
  const fake = await startFake(t, () => undefined);
  const client = makeClient({ socketPath: fake.socketPath, timeoutMs: 40, delay: noDelay, attempts: 2 });
  await assert.rejects(
    client.status(),
    (e) => e instanceof DozeboxError && e.code === "transport" && e.retryable && /40 ms/.test(e.message),
  );
  assert.equal(fake.seen.length, 2);
});

test("an aborted signal is a transport error that is not retried", async (t) => {
  const fake = await startFake(t, () => undefined);
  const controller = new AbortController();
  const client = makeClient({ socketPath: fake.socketPath, signal: controller.signal, delay: noDelay });
  const pending = client.status();
  controller.abort();
  await assert.rejects(pending, (e) => e instanceof DozeboxError && e.code === "transport" && !e.retryable);
});

test("a dead socket is a transport error", async (t) => {
  const fake = await startFake(t, (_req, res) => reply(res, 200, status));
  const client = makeClient({ socketPath: `${fake.socketPath}.gone`, delay: noDelay, attempts: 2 });
  await assert.rejects(client.hello(), (e) => e instanceof DozeboxError && e.code === "transport");
});

test("status reads extra fields and unknown enum values without throwing", async (t) => {
  const body = { ...status, box: { ...status.box, phase: "hibernating", newField: 1 }, extra: { a: 1 } };
  const fake = await startFake(t, (_req, res) => reply(res, 200, body));
  const got = await makeClient({ socketPath: fake.socketPath }).status();
  assert.equal(got.box.phase, "serving");
});

test("a status that does not match the schema is a non-retryable transport error", async (t) => {
  const fake = await startFake(t, (_req, res) => reply(res, 200, { box: { id: "main" } }));
  const client = makeClient({ socketPath: fake.socketPath, delay: noDelay });
  await assert.rejects(client.status(), (e) => e instanceof DozeboxError && e.code === "transport" && !e.retryable);
  assert.equal(fake.seen.length, 1);
});

test("requests use the documented routes and bodies", async (t) => {
  const fake = await startFake(t, (req, res) =>
    req.method === "DELETE" || req.url === "/v1/beats" || req.url?.startsWith("/v1/presence/")
      ? reply(res, 204)
      : reply(res, 200, { id: "x", alertId: "a", deduped: false }),
  );
  const client = makeClient({ socketPath: fake.socketPath, now: () => Date.parse(at) });
  await client.release("run 1");
  await client.cancelWake("w1");
  await client.beat([{ kind: "progress", name: "turn" }]);
  await client.presence("web", "viewing", 60);
  await client.attention({ key: "k", severity: "info", title: "t", body: "b" });
  const calls = fake.seen.map((s) => `${s.method} ${s.url}`);
  assert.deepEqual(calls, [
    "DELETE /v1/holds/run%201",
    "DELETE /v1/wakes/w1",
    "POST /v1/beats",
    "PUT /v1/presence/web",
    "POST /v1/attention",
  ]);
  assert.deepEqual(fake.seen[2]?.body, { beats: [{ kind: "progress", name: "turn" }] });
  assert.deepEqual(fake.seen[3]?.body, { kind: "viewing", until: "2026-11-24T21:01:00.000Z" });
});

test("sleep maps 202 to accepted and 409 SleepRefused to blockers", async (t) => {
  let refuse = false;
  const fake = await startFake(t, (_req, res) =>
    refuse
      ? reply(res, 409, { error: { code: "conflict", message: "no", retryable: false }, blockers: ["hold:p/run-1"] })
      : reply(res, 202, { parkingAt: at }),
  );
  const client = makeClient({ socketPath: fake.socketPath });
  assert.deepEqual(await client.sleep(), { accepted: true, blockers: [] });
  refuse = true;
  assert.deepEqual(await client.sleep({ force: false }), { accepted: false, blockers: ["hold:p/run-1"] });
  assert.deepEqual(fake.seen[1]?.body, { reason: "user", force: false });
});

test("a 409 without blockers is an ordinary error", async (t) => {
  const fake = await startFake(t, (_req, res) => reply(res, 409, errorBody("conflict", false)));
  await assert.rejects(makeClient({ socketPath: fake.socketPath }).sleep(), (e) => e instanceof DozeboxError);
});

test("createClient is null without a socket", () => {
  const saved = process.env["DOZEBOX_SOCKET"];
  try {
    delete process.env["DOZEBOX_SOCKET"];
    assert.equal(createClient(), null);
    process.env["DOZEBOX_SOCKET"] = "";
    assert.equal(createClient(), null);
    assert.equal(createClient({ socketPath: "" }), null);
    process.env["DOZEBOX_SOCKET"] = "/run/dozebox/payloads/x.sock";
    assert.notEqual(createClient(), null);
  } finally {
    if (saved === undefined) delete process.env["DOZEBOX_SOCKET"];
    else process.env["DOZEBOX_SOCKET"] = saved;
  }
});
