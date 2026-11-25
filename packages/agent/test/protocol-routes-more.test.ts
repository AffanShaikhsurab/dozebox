// Protocol server conformance, continued: attention, health and sleep.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { API, at, err, hold, MIN, setup, T0 } from "./protocol-support.ts";

describe("protocol routes: attention", () => {
  const page = { key: "run-42:needs-human", severity: "page", title: "Run 42 needs you", body: "stopped" };

  it("accepts (202) and hands it to the forwarder", async () => {
    const { t, call } = await setup();
    const res = await call("POST", "/v1/attention", page);
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { alertId: "alert-1", deduped: false });
    assert.equal(t.sent[0]?.payload, "web");
  });

  it("the same key inside dedupe is deduped and not sent again", async () => {
    const { t, call } = await setup();
    await call("POST", "/v1/attention", page);
    t.now += 30 * MIN;
    assert.deepEqual((await call("POST", "/v1/attention", page)).body, { alertId: "alert-1", deduped: true });
    t.now += 31 * MIN;
    assert.deepEqual((await call("POST", "/v1/attention", page)).body, { alertId: "alert-2", deduped: false });
    assert.equal(t.sent.length, 2);
  });

  it("dedupe keys are per payload", async () => {
    const { t, call } = await setup();
    await call("POST", "/v1/attention", page);
    await call("POST", "/v1/attention", page, { socket: API });
    assert.equal(t.sent.length, 2);
  });

  it("the 6th page in an hour is rate_limited with Retry-After", async () => {
    const { t, call } = await setup();
    for (let i = 0; i < 5; i++)
      assert.equal((await call("POST", "/v1/attention", { ...page, key: `k${i}` })).status, 202);
    const res = await call("POST", "/v1/attention", { ...page, key: "k5" });
    err(res, 429, "rate_limited");
    assert.equal(res.headers?.["retry-after"], "3600");
    t.now += 60 * MIN;
    assert.equal((await call("POST", "/v1/attention", { ...page, key: "k6" })).status, 202);
  });

  it("the 31st alert in an hour is rate_limited; deduped calls do not count", async () => {
    const { call } = await setup();
    const note = { ...page, severity: "notify" };
    for (let i = 0; i < 30; i++) await call("POST", "/v1/attention", { ...note, key: `k${i}` });
    assert.equal((await call("POST", "/v1/attention", { ...note, key: "k0" })).status, 202, "deduped");
    err(await call("POST", "/v1/attention", { ...note, key: "k30" }), 429, "rate_limited");
  });

  it("an http url and an unknown severity are refused", async () => {
    const { call } = await setup();
    err(await call("POST", "/v1/attention", { ...page, url: "http://x" }), 400, "invalid_value", "url");
    err(await call("POST", "/v1/attention", { ...page, severity: "loud" }), 400, "invalid_value", "severity");
  });
});

describe("protocol routes: health and sleep", () => {
  it("PUT /v1/health is stored for its ttl", async () => {
    const { call, store } = await setup();
    assert.equal((await call("PUT", "/v1/health", { ok: false, detail: "x", ttlSeconds: 60 })).status, 204);
    assert.deepEqual(store.healthOf("web", T0), { ok: false, detail: "x" });
    err(await call("PUT", "/v1/health", { ok: true, ttlSeconds: 5 }), 400, "invalid_value", "ttlSeconds");
  });

  it("sleep with no other work holds is accepted and releases the caller's holds", async () => {
    const { t, call, store } = await setup();
    await call("PUT", "/v1/holds/mine", hold(30));
    await call("PUT", "/v1/holds/theirs", hold(30, { kind: "wait" }), { socket: API });
    const res = await call("POST", "/v1/sleep", { reason: "user" });
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { parkingAt: at(T0) });
    assert.deepEqual(t.sleeps, [false]);
    assert.deepEqual(
      (await store.holds(T0)).map((h) => h.key),
      ["api/theirs"],
    );
  });

  it("another payload's work hold blocks it (409 with blockers) unless force", async () => {
    const { t, call, store } = await setup();
    await call("PUT", "/v1/holds/mine", hold(30));
    await call("PUT", "/v1/holds/job-7", hold(30), { socket: API });
    const res = await call("POST", "/v1/sleep", { reason: "user" });
    assert.equal(res.status, 409);
    assert.deepEqual((res.body as { blockers: string[] }).blockers, ["hold:api/job-7"]);
    assert.equal(t.sleeps.length, 0);
    assert.equal((await store.holds(T0)).length, 2, "a refused sleep releases nothing");
    assert.equal((await call("POST", "/v1/sleep", { reason: "user", force: true })).status, 202);
    assert.deepEqual(t.sleeps, [true]);
  });

  it("a refusal from the park side is 409 with its blockers", async () => {
    const { t, call } = await setup();
    t.sleepAnswer = { accepted: false, blockers: ["frozen"] };
    const res = await call("POST", "/v1/sleep", { reason: "user", force: true });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, {
      error: { code: "conflict", message: "the box cannot sleep now", retryable: false },
      blockers: ["frozen"],
    });
  });

  it("reason other than user is invalid_value", async () => {
    const { call } = await setup();
    err(await call("POST", "/v1/sleep", { reason: "idle" }), 400, "invalid_value", "reason");
  });
});
