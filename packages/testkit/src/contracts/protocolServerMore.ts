// Protocol server conformance, continued: beats, wakes, presence, attention, health and sleep. `protocolServerSuite`
// registers every case (protocolServer.ts has the fixture the harness must provide).
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  adminHolds,
  API,
  at,
  err,
  hold,
  PROTOCOL_T0 as T0,
  protocolServerCore,
  type ProtocolHarness,
} from "./protocolServer.ts";

const MIN = 60_000;

function protocolServerMore(name: string, make: () => Promise<ProtocolHarness>): void {
  describe(`${name}: beats`, () => {
    it("accepts a batch (204); empty batches, bad names, unknown nested fields and stale beats are refused", async () => {
      const h = await make();
      const ok = await h.call("POST", "/v1/beats", {
        beats: [
          { kind: "progress", name: "turn", at: at(T0 - 1000) },
          { kind: "loop", name: "scheduler", expectEverySeconds: 300 },
        ],
      });
      assert.equal(ok.status, 204);
      err(await h.call("POST", "/v1/beats", { beats: [] }), 400, "invalid_value", "beats");
      err(
        await h.call("POST", "/v1/beats", { beats: [{ kind: "progress", name: "Turn" }] }),
        400,
        "invalid_value",
        "beats[0].name",
      );
      err(
        await h.call("POST", "/v1/beats", { beats: [{ kind: "progress", name: "turn", x: 1 }] }),
        400,
        "unknown_field",
        "beats[0].x",
      );
      const old = { beats: [{ kind: "progress", name: "t", at: at(T0 - 10 * MIN) }] };
      err(await h.call("POST", "/v1/beats", old), 400, "invalid_value", "beats[0].at");
    });
  });

  describe(`${name}: wakes`, () => {
    it("PUT, GET and DELETE a timed wake", async () => {
      const h = await make();
      const res = await h.call("PUT", "/v1/wakes/nightly", { reason: "nightly", at: at(T0 + 60 * MIN) });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, {
        id: "nightly",
        reason: "nightly",
        at: at(T0 + 60 * MIN),
        expiresAt: at(T0 + 120 * MIN),
      });
      assert.equal(((await h.call("GET", "/v1/wakes")).body as { wakes: unknown[] }).wakes.length, 1);
      assert.equal((await h.call("DELETE", "/v1/wakes/nightly")).status, 204);
      err(await h.call("DELETE", "/v1/wakes/nightly"), 404, "not_found");
    });

    it("needs at or on; a GitHub event wake checks its shape; the 11th wake is limit_exceeded", async () => {
      const h = await make();
      err(await h.call("PUT", "/v1/wakes/w", { reason: "r" }), 400, "invalid_value", "at");
      const on = { source: "github", repository: "o/n", events: ["check_suite"], number: 81, actions: ["completed"] };
      assert.equal((await h.call("PUT", "/v1/wakes/ci", { reason: "ci", on })).status, 200);
      err(
        await h.call("PUT", "/v1/wakes/ci", { reason: "ci", on: { source: "github", events: ["x"] } }),
        400,
        "invalid_value",
      );
      for (let i = 0; i < 9; i++) await h.call("PUT", `/v1/wakes/w${i}`, { reason: "r", at: at(T0 + MIN) });
      err(await h.call("PUT", "/v1/wakes/w10", { reason: "r", at: at(T0 + MIN) }), 409, "limit_exceeded");
    });
  });

  describe(`${name}: presence`, () => {
    it("PUT clamps to 15 minutes and DELETE ends it; src: ids and unknown kinds are refused", async () => {
      const h = await make();
      const res = await h.call("PUT", "/v1/presence/web-tab", {
        until: at(T0 + 60 * MIN),
        kind: "interactive",
        label: "web",
      });
      assert.deepEqual(res.body, { id: "web-tab", kind: "interactive", until: at(T0 + 15 * MIN) });
      assert.equal((await h.call("DELETE", "/v1/presence/web-tab")).status, 204);
      err(await h.call("DELETE", "/v1/presence/web-tab"), 404, "not_found");
      err(
        await h.call("PUT", "/v1/presence/src:ssh", { until: at(T0 + MIN), kind: "interactive" }),
        400,
        "invalid_value",
        "id",
      );
      err(
        await h.call("PUT", "/v1/presence/p", { until: at(T0 + MIN), kind: "focused" }),
        400,
        "invalid_value",
        "kind",
      );
    });
  });

  describe(`${name}: attention`, () => {
    const page = { key: "run-42:needs-human", severity: "page", title: "Run 42 needs you", body: "stopped" };

    it("accepts (202), dedupes the same key for an hour, per payload", async () => {
      const h = await make();
      assert.deepEqual((await h.call("POST", "/v1/attention", page)).body, { alertId: "alert-1", deduped: false });
      assert.equal(h.sent[0]?.payload, "web");
      h.advance(30 * MIN);
      assert.deepEqual((await h.call("POST", "/v1/attention", page)).body, { alertId: "alert-1", deduped: true });
      h.advance(31 * MIN);
      assert.deepEqual((await h.call("POST", "/v1/attention", page)).body, { alertId: "alert-2", deduped: false });
      await h.call("POST", "/v1/attention", page, { socket: API });
      assert.equal(h.sent.length, 3);
    });

    it("the 6th page in an hour is rate_limited with Retry-After", async () => {
      const h = await make();
      for (let i = 0; i < 5; i++)
        assert.equal((await h.call("POST", "/v1/attention", { ...page, key: `k${i}` })).status, 202);
      const res = await h.call("POST", "/v1/attention", { ...page, key: "k5" });
      err(res, 429, "rate_limited");
      assert.equal(res.headers?.["retry-after"], "3600");
      h.advance(60 * MIN);
      assert.equal((await h.call("POST", "/v1/attention", { ...page, key: "k6" })).status, 202);
    });

    it("the 31st alert in an hour is rate_limited; deduped calls do not count", async () => {
      const h = await make();
      const note = { ...page, severity: "notify" };
      for (let i = 0; i < 30; i++) await h.call("POST", "/v1/attention", { ...note, key: `k${i}` });
      assert.equal((await h.call("POST", "/v1/attention", { ...note, key: "k0" })).status, 202, "deduped");
      err(await h.call("POST", "/v1/attention", { ...note, key: "k30" }), 429, "rate_limited");
    });

    it("an http url and an unknown severity are refused", async () => {
      const h = await make();
      err(await h.call("POST", "/v1/attention", { ...page, url: "http://x" }), 400, "invalid_value", "url");
      err(await h.call("POST", "/v1/attention", { ...page, severity: "loud" }), 400, "invalid_value", "severity");
    });
  });

  describe(`${name}: health and sleep`, () => {
    it("PUT /v1/health is accepted; a ttl under the minimum is refused", async () => {
      const h = await make();
      assert.equal((await h.call("PUT", "/v1/health", { ok: false, detail: "x", ttlSeconds: 60 })).status, 204);
      err(await h.call("PUT", "/v1/health", { ok: true, ttlSeconds: 5 }), 400, "invalid_value", "ttlSeconds");
    });

    it("sleep with no other work holds is accepted and releases the caller's holds", async () => {
      const h = await make();
      await h.call("PUT", "/v1/holds/mine", hold(30));
      await h.call("PUT", "/v1/holds/theirs", hold(30, { kind: "wait" }), { socket: API });
      const res = await h.call("POST", "/v1/sleep", { reason: "user" });
      assert.equal(res.status, 202);
      assert.deepEqual(res.body, { parkingAt: at(T0) });
      assert.deepEqual(h.sleeps, [false]);
      assert.equal((await adminHolds(h)).length, 1);
    });

    it("another payload's work hold blocks it (409 with blockers) unless force", async () => {
      const h = await make();
      await h.call("PUT", "/v1/holds/mine", hold(30));
      await h.call("PUT", "/v1/holds/job-7", hold(30), { socket: API });
      const res = await h.call("POST", "/v1/sleep", { reason: "user" });
      assert.equal(res.status, 409);
      assert.deepEqual((res.body as { blockers: string[] }).blockers, ["hold:api/job-7"]);
      assert.equal(h.sleeps.length, 0);
      assert.equal((await adminHolds(h)).length, 2, "a refused sleep releases nothing");
      assert.equal((await h.call("POST", "/v1/sleep", { reason: "user", force: true })).status, 202);
      assert.deepEqual(h.sleeps, [true]);
    });

    it("a refusal from the park side is 409 with its blockers; a reason other than user is invalid_value", async () => {
      const h = await make();
      h.setSleepAnswer({ accepted: false, blockers: ["frozen"] });
      const res = await h.call("POST", "/v1/sleep", { reason: "user", force: true });
      assert.equal(res.status, 409);
      assert.deepEqual(res.body, {
        error: { code: "conflict", message: "the box cannot sleep now", retryable: false },
        blockers: ["frozen"],
      });
      err(await h.call("POST", "/v1/sleep", { reason: "idle" }), 400, "invalid_value", "reason");
    });
  });
}

/** Register every protocol server conformance case under `name`; `makeHandler` builds a fresh harness per case. */
export function protocolServerSuite(makeHandler: () => Promise<ProtocolHarness>, name = "protocol server"): void {
  protocolServerCore(name, makeHandler);
  protocolServerMore(name, makeHandler);
}
