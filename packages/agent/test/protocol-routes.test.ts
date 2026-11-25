// The protocol server conformance cases (part 4 §4.19), run in-process against the routes and a real store.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADMIN, API, at, err, hold, MIN, setup, T0 } from "./protocol-support.ts";

describe("protocol routes: hello and status", () => {
  it("hello names the payload, versions and limits", async () => {
    const { call } = await setup();
    const res = await call("GET", "/v1/hello");
    assert.equal(res.status, 200);
    const b = res.body as { protocol: unknown; payload: unknown; agent: unknown; limits: Record<string, number> };
    assert.deepEqual(b.protocol, { major: 1, minor: 0 });
    assert.deepEqual(b.payload, { name: "web" });
    assert.deepEqual(b.agent, { version: "1.2.3" });
    assert.equal(b.limits["holdsPerPayload"], 64);
    assert.equal(b.limits["wakeHorizonSeconds"], 3_024_000);
  });

  it("hello reports the payload's own holdMaxSeconds", async () => {
    const { call } = await setup();
    const b = (await call("GET", "/v1/hello", undefined, { socket: API })).body as { limits: Record<string, number> };
    assert.equal(b.limits["holdMaxSeconds"], 3600);
  });

  it("status is asked for the caller's payload; admin without a header asks for all", async () => {
    const { t, call } = await setup();
    assert.equal((await call("GET", "/v1/status")).status, 200);
    await call("GET", "/v1/status", undefined, { socket: ADMIN });
    await call("GET", "/v1/status", undefined, { socket: ADMIN, headers: { "x-dozebox-payload": "api" } });
    assert.deepEqual(t.statusFor, ["web", null, "api"]);
  });

  it("/v2 is unsupported_version, an unknown /v1 path not_found, a wrong method bad_request", async () => {
    const { call } = await setup();
    err(await call("GET", "/v2/hello"), 404, "unsupported_version");
    err(await call("GET", "/v1/nope"), 404, "not_found");
    err(await call("POST", "/v1/hello"), 400, "bad_request");
  });
});

describe("protocol routes: holds", () => {
  it("PUT twice keeps since and reports the change", async () => {
    const { t, call } = await setup();
    const a = (await call("PUT", "/v1/holds/run-42", hold(30))).body as { since: string };
    t.now += MIN;
    const b = (await call("PUT", "/v1/holds/run-42", hold(40))).body as { since: string; until: string };
    assert.equal(b.since, a.since);
    assert.equal(b.until, at(T0 + 40 * MIN));
    assert.deepEqual(t.changes, ["holds:web", "holds:web"]);
  });

  it("an unknown field is 400 unknown_field naming it", async () => {
    const { call } = await setup();
    err(await call("PUT", "/v1/holds/a", hold(5, { color: "red" })), 400, "unknown_field", "color");
  });

  it("a missing field is bad_request, a body that is not an object bad_request", async () => {
    const { call } = await setup();
    err(await call("PUT", "/v1/holds/a", { reason: "r" }), 400, "bad_request", "until");
    err(await call("PUT", "/v1/holds/a", undefined), 400, "bad_request");
    err(await call("PUT", "/v1/holds/a", ["x"]), 400, "bad_request");
  });

  it("an out-of-range value is invalid_value with its field", async () => {
    const { call } = await setup();
    err(await call("PUT", "/v1/holds/a", hold(5, { maxSeconds: 10 })), 400, "invalid_value", "maxSeconds");
    err(await call("PUT", "/v1/holds/a", hold(5, { kind: "forever" })), 400, "invalid_value", "kind");
    err(await call("PUT", "/v1/holds/a", { reason: "", until: at(T0 + MIN) }), 400, "invalid_value", "reason");
  });

  it("until in the past is invalid_value until", async () => {
    const { call } = await setup();
    err(await call("PUT", "/v1/holds/a", hold(-1)), 400, "invalid_value", "until");
  });

  it("a bad id is invalid_value id", async () => {
    const { call } = await setup();
    err(await call("PUT", "/v1/holds/Upper", hold(5)), 400, "invalid_value", "id");
    err(await call("PUT", `/v1/holds/${"a".repeat(65)}`, hold(5)), 400, "invalid_value", "id");
  });

  it("the 65th hold is limit_exceeded (409)", async () => {
    const { call } = await setup();
    for (let i = 0; i < 64; i++) assert.equal((await call("PUT", `/v1/holds/h${i}`, hold(5))).status, 200);
    err(await call("PUT", "/v1/holds/h64", hold(5)), 409, "limit_exceeded");
  });

  it("GET lists only the caller's live holds", async () => {
    const { t, call } = await setup();
    await call("PUT", "/v1/holds/a", hold(5));
    await call("PUT", "/v1/holds/b", hold(1));
    await call("PUT", "/v1/holds/c", hold(5), { socket: API });
    t.now += MIN;
    const list = (await call("GET", "/v1/holds")).body as { holds: Array<{ id: string }> };
    assert.deepEqual(
      list.holds.map((h) => h.id),
      ["a"],
    );
  });

  it("DELETE releases (204), an unknown id is not_found", async () => {
    const { call } = await setup();
    await call("PUT", "/v1/holds/a", hold(5));
    const res = await call("DELETE", "/v1/holds/a");
    assert.equal(res.status, 204);
    assert.equal(res.body, undefined);
    err(await call("DELETE", "/v1/holds/a"), 404, "not_found");
  });

  it("an expired hold does not keep the box awake", async () => {
    const { t, call, store } = await setup();
    await call("PUT", "/v1/holds/a", hold(1));
    t.now += MIN;
    assert.deepEqual(await store.holds(t.now), []);
  });

  it("writes while parking are 503 shutting_down (retryable), reads still work", async () => {
    const { t, call } = await setup();
    t.accepting = false;
    const res = await call("PUT", "/v1/holds/a", hold(5));
    err(res, 503, "shutting_down");
    assert.equal((res.body as { error: { retryable: boolean } }).error.retryable, true);
    assert.equal((await call("GET", "/v1/holds")).status, 200);
  });
});

describe("protocol routes: admin socket", () => {
  it("writes need the payload header", async () => {
    const { call } = await setup();
    err(await call("PUT", "/v1/holds/a", hold(5), { socket: ADMIN }), 400, "bad_request", "x-dozebox-payload");
  });

  it("writes with the header act as that payload; an unknown payload is refused", async () => {
    const { call, store } = await setup();
    const res = await call("PUT", "/v1/holds/a", hold(5), { socket: ADMIN, headers: { "x-dozebox-payload": "api" } });
    assert.equal(res.status, 200);
    assert.deepEqual(
      (await store.holds(T0)).map((h) => h.key),
      ["api/a"],
    );
    err(
      await call("PUT", "/v1/holds/a", hold(5), { socket: ADMIN, headers: { "x-dozebox-payload": "nope" } }),
      400,
      "invalid_value",
    );
  });

  it("admin GET without the header lists every payload", async () => {
    const { call } = await setup();
    await call("PUT", "/v1/holds/a", hold(5));
    await call("PUT", "/v1/holds/b", hold(5), { socket: API });
    const list = (await call("GET", "/v1/holds", undefined, { socket: ADMIN })).body as { holds: unknown[] };
    assert.equal(list.holds.length, 2);
  });
});

describe("protocol routes: beats", () => {
  it("accepts a batch (204)", async () => {
    const { call, store } = await setup();
    const res = await call("POST", "/v1/beats", {
      beats: [
        { kind: "progress", name: "turn", at: at(T0 - 1000) },
        { kind: "loop", name: "scheduler", expectEverySeconds: 300 },
      ],
    });
    assert.equal(res.status, 204);
    assert.equal(await store.lastProgressAt(), T0 - 1000);
  });

  it("an empty batch, a bad name and an unknown nested field are refused", async () => {
    const { call } = await setup();
    err(await call("POST", "/v1/beats", { beats: [] }), 400, "invalid_value", "beats");
    err(
      await call("POST", "/v1/beats", { beats: [{ kind: "progress", name: "Turn" }] }),
      400,
      "invalid_value",
      "beats[0].name",
    );
    err(
      await call("POST", "/v1/beats", { beats: [{ kind: "progress", name: "turn", x: 1 }] }),
      400,
      "unknown_field",
      "beats[0].x",
    );
  });

  it("a beat from the far past is invalid_value", async () => {
    const { call } = await setup();
    err(
      await call("POST", "/v1/beats", { beats: [{ kind: "progress", name: "t", at: at(T0 - 10 * MIN) }] }),
      400,
      "invalid_value",
      "beats[0].at",
    );
  });
});

describe("protocol routes: wakes", () => {
  it("PUT, GET and DELETE a timed wake", async () => {
    const { t, call } = await setup();
    const res = await call("PUT", "/v1/wakes/nightly", { reason: "nightly", at: at(T0 + 60 * MIN) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      id: "nightly",
      reason: "nightly",
      at: at(T0 + 60 * MIN),
      expiresAt: at(T0 + 120 * MIN),
    });
    const list = (await call("GET", "/v1/wakes")).body as { wakes: unknown[] };
    assert.equal(list.wakes.length, 1);
    assert.equal((await call("DELETE", "/v1/wakes/nightly")).status, 204);
    err(await call("DELETE", "/v1/wakes/nightly"), 404, "not_found");
    assert.deepEqual(t.changes, ["wakes:web", "wakes:web"]);
  });

  it("needs at or on", async () => {
    const { call } = await setup();
    err(await call("PUT", "/v1/wakes/w", { reason: "r" }), 400, "invalid_value", "at");
  });

  it("an event wake on GitHub needs a repository and checks its shape", async () => {
    const { call } = await setup();
    const on = { source: "github", repository: "o/n", events: ["check_suite"], number: 81, actions: ["completed"] };
    assert.equal((await call("PUT", "/v1/wakes/ci", { reason: "ci", on })).status, 200);
    err(
      await call("PUT", "/v1/wakes/ci", { reason: "ci", on: { source: "github", events: ["x"] } }),
      400,
      "invalid_value",
    );
  });

  it("the 11th wake of a payload is limit_exceeded", async () => {
    const { call } = await setup();
    for (let i = 0; i < 10; i++) await call("PUT", `/v1/wakes/w${i}`, { reason: "r", at: at(T0 + MIN) });
    err(await call("PUT", "/v1/wakes/w10", { reason: "r", at: at(T0 + MIN) }), 409, "limit_exceeded");
  });
});

describe("protocol routes: presence", () => {
  it("PUT clamps to 15 minutes and DELETE ends it", async () => {
    const { call, store } = await setup();
    const res = await call("PUT", "/v1/presence/web-tab", {
      until: at(T0 + 60 * MIN),
      kind: "interactive",
      label: "web",
    });
    assert.deepEqual(res.body, { id: "web-tab", kind: "interactive", until: at(T0 + 15 * MIN) });
    assert.equal(await store.lastInteractiveAt(), T0);
    assert.equal((await call("DELETE", "/v1/presence/web-tab")).status, 204);
    err(await call("DELETE", "/v1/presence/web-tab"), 404, "not_found");
  });

  it("payloads cannot write src: ids", async () => {
    const { call } = await setup();
    err(
      await call("PUT", "/v1/presence/src:ssh", { until: at(T0 + MIN), kind: "interactive" }),
      400,
      "invalid_value",
      "id",
    );
  });

  it("an unknown kind is invalid_value", async () => {
    const { call } = await setup();
    err(await call("PUT", "/v1/presence/p", { until: at(T0 + MIN), kind: "focused" }), 400, "invalid_value", "kind");
  });
});
