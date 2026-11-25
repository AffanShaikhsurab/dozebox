import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { controlStatusFixture, makeAutoClock } from "@dozebox/testkit/fakes";
import {
  EMPTY_BODY_SHA256,
  makeControlApi,
  type ControlApiDeps,
  type SignableRequest,
} from "../src/adapters/control.ts";
import { DozeboxCliError } from "../src/command.ts";

type Reply = Response | Error;
type Seen = {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers });

function setup(replies: Reply[], over: Partial<ControlApiDeps> = {}) {
  const seen: Seen[] = [];
  const clock = makeAutoClock();
  let tokenReads = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body,
    });
    const next = replies.shift();
    if (next === undefined) throw new Error("no reply scripted");
    if (next instanceof Error) throw next;
    return next;
  };
  const api = makeControlApi({
    controlUrl: "https://ctl.example",
    functionName: "dozebox-main-control",
    token: async () => (tokenReads++, "tok"),
    fetch: fakeFetch,
    clock,
    sign: null,
    invokeAdmin: async () => ({ functionError: null, payload: { ok: true } }),
    ...over,
  });
  return { api, seen, clock, tokenReads: () => tokenReads };
}

const rejectsWith = async (p: Promise<unknown>, code: string, match?: RegExp): Promise<void> => {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof DozeboxCliError);
    assert.equal(e.code, code);
    if (match) assert.match(e.message, match);
    return true;
  });
};

const servingStatus = controlStatusFixture({ state: "running", servingSince: "2026-11-25T00:01:00.000Z" });

describe("control API: wake", () => {
  it("maps 202, 429 and 423", async () => {
    const accepted = setup([json(202, controlStatusFixture({ state: "launching" }))]);
    const answer = await accepted.api.wake({ idempotencyKey: "k1", origin: "user" });
    assert.equal(answer.kind, "accepted");
    assert.equal(accepted.seen[0]?.url, "https://ctl.example/v1/wake?origin=user");
    assert.equal(accepted.seen[0]?.headers["Idempotency-Key"], "k1");

    const budget = setup([json(429, { error: { code: "wake_budget", retryAfterSeconds: 42 } })]);
    assert.deepEqual(await budget.api.wake({ idempotencyKey: "k", origin: "auto" }), {
      kind: "budget",
      retryAfterSeconds: 42,
    });

    const frozen = setup([json(423, { error: { code: "frozen" } })]);
    assert.deepEqual(await frozen.api.wake({ idempotencyKey: "k", origin: "user" }), { kind: "frozen" });
  });

  it("reads the retry delay from retryAfterMs, then the header, then defaults to 60", async () => {
    const ms = setup([json(429, { error: { retryAfterMs: 1500 } })]);
    assert.deepEqual(await ms.api.wake({ idempotencyKey: "k", origin: "user" }), {
      kind: "budget",
      retryAfterSeconds: 2,
    });
    const header = setup([json(429, { error: { code: "wake_budget" } }, { "Retry-After": "17" })]);
    assert.deepEqual(await header.api.wake({ idempotencyKey: "k", origin: "user" }), {
      kind: "budget",
      retryAfterSeconds: 17,
    });
    const none = setup([json(429, {})]);
    assert.deepEqual(await none.api.wake({ idempotencyKey: "k", origin: "user" }), {
      kind: "budget",
      retryAfterSeconds: 60,
    });
  });

  it("sends the token on every call and the empty-body hash on wake", async () => {
    const s = setup([json(200, controlStatusFixture()), json(202, controlStatusFixture())]);
    await s.api.status();
    await s.api.wake({ idempotencyKey: "k", origin: "user" });
    assert.equal(s.seen[0]?.headers["x-dozebox-token"], "tok");
    assert.equal(s.seen[1]?.headers["x-dozebox-token"], "tok");
    assert.equal(s.seen[0]?.headers["x-amz-content-sha256"], undefined);
    assert.equal(s.seen[1]?.headers["x-amz-content-sha256"], EMPTY_BODY_SHA256);
    assert.equal(s.seen[1]?.body, undefined);
    assert.equal(s.tokenReads(), 1);
  });

  it("signs the request when a signer is set", async () => {
    const signed: SignableRequest[] = [];
    const s = setup([json(200, controlStatusFixture())], {
      sign: async (req) => (signed.push(req), { ...req, headers: { ...req.headers, authorization: "AWS4 sig" } }),
    });
    await s.api.status();
    assert.equal(signed[0]?.url, "https://ctl.example/v1/status");
    assert.equal(s.seen[0]?.headers["authorization"], "AWS4 sig");
  });
});

describe("control API: errors", () => {
  it("retries 5xx and network errors at 1 s, 2 s, 4 s, then exits as an AWS error", async () => {
    const s = setup([json(502, {}), new TypeError("fetch failed"), json(503, {}), json(500, {})]);
    await rejectsWith(s.api.status(), "aws");
    assert.deepEqual(s.clock.slept, [1000, 2000, 4000]);
    assert.equal(s.seen.length, 4);
  });

  it("succeeds when a retry gets through", async () => {
    const s = setup([json(500, {}), json(200, controlStatusFixture())]);
    assert.equal((await s.api.status()).box, "main");
    assert.deepEqual(s.clock.slept, [1000]);
  });

  it("maps 401 and 403 to refused", async () => {
    for (const status of [401, 403]) {
      const s = setup([json(status, { error: { message: "no" } })]);
      await rejectsWith(s.api.status(), "refused", /dozebox token rotate/);
      assert.equal(s.seen.length, 1);
    }
  });

  it("maps other non-2xx to a problem with the body's message", async () => {
    const s = setup([json(400, { error: { message: "bad origin" } })]);
    await rejectsWith(s.api.wake({ idempotencyKey: "k", origin: "user" }), "problem", /bad origin/);
  });
});

describe("control API: waitFor", () => {
  it("polls every 10 s until servingSince is set", async () => {
    const s = setup([
      json(200, controlStatusFixture({ state: "launching" })),
      json(200, controlStatusFixture({ state: "running", servingSince: null })),
      json(200, servingStatus),
    ]);
    const done = await s.api.waitFor("serving", new AbortController().signal);
    assert.equal(done.servingSince, "2026-11-25T00:01:00.000Z");
    assert.deepEqual(s.clock.slept, [10_000, 10_000]);
  });

  it("returns on a running machine when waiting for running", async () => {
    const s = setup([json(200, controlStatusFixture({ state: "running", servingSince: null }))]);
    assert.equal((await s.api.waitFor("running", new AbortController().signal)).state, "running");
  });

  it("throws the last error when the box stops in error", async () => {
    const s = setup([
      json(
        200,
        controlStatusFixture({
          state: "stopped-error",
          lastError: { message: "no capacity", at: "2026-11-25T00:00:00.000Z", source: "ctl" },
        }),
      ),
    ]);
    await rejectsWith(s.api.waitFor("serving", new AbortController().signal), "problem", /no capacity/);
  });

  it("falls back to the summary headline without a last error", async () => {
    const s = setup([json(200, controlStatusFixture({ state: "stopped-error" }))]);
    await rejectsWith(s.api.waitFor("running", new AbortController().signal), "problem", /Asleep\./);
  });

  it("rethrows the abort reason", async () => {
    const c = new AbortController();
    const reason = new Error("stop");
    c.abort(reason);
    const s = setup([]);
    await assert.rejects(s.api.waitFor("serving", c.signal), (e: unknown) => e === reason);

    const c2 = new AbortController();
    const base = makeAutoClock();
    const clock = { ...base, sleep: async (ms: number, sig?: AbortSignal) => (c2.abort(reason), base.sleep(ms, sig)) };
    const s2 = setup([json(200, controlStatusFixture({ state: "launching" }))], { clock });
    await assert.rejects(s2.api.waitFor("serving", c2.signal), (e: unknown) => e === reason);
  });
});

describe("control API: alerts and admin", () => {
  it("posts the severity as JSON with its hash", async () => {
    const s = setup([json(202, {})]);
    await s.api.alertsTest("page");
    const sent = s.seen[0];
    assert.equal(sent?.url, "https://ctl.example/v1/alerts/test");
    assert.equal(sent?.body, '{"severity":"page"}');
    assert.equal(sent?.headers["content-type"], "application/json");
    assert.match(sent?.headers["x-amz-content-sha256"] ?? "", /^[0-9a-f]{64}$/);
    assert.notEqual(sent?.headers["x-amz-content-sha256"], EMPTY_BODY_SHA256);
  });

  it("invokes admin events with the dozebox envelope", async () => {
    const payloads: object[] = [];
    const s = setup([], {
      invokeAdmin: async (p) => (payloads.push(p), { functionError: null, payload: { parked: true } }),
    });
    const out = await s.api.admin({ action: "park", force: true, reason: "test" });
    assert.deepEqual(payloads, [{ dozebox: "admin", v: 1, action: "park", force: true, reason: "test" }]);
    assert.deepEqual(out, { parked: true });
  });

  it("names a function error", async () => {
    const s = setup([], {
      invokeAdmin: async () => ({ functionError: "Unhandled", payload: { errorMessage: "boom" } }),
    });
    await rejectsWith(s.api.admin({ action: "rebuild", reason: "x" }), "problem", /Unhandled.*boom/);
  });
});
