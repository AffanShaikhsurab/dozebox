// C5 hook route: 404/413/401 short-circuits, match, 24 h dedupe and the single wake request.
import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import type { BoxWakes, HookRequest } from "../src/ports/wakeSource.ts";
import { handleHook, type HookDeps } from "../src/wake/hooks.ts";
import { genericSource } from "../src/wake/sources/generic.ts";
import { githubSource } from "../src/wake/sources/github.ts";

const NOW = Date.parse("2026-11-25T10:00:00Z");
const SECRET = "s3cret";
const secret = async (): Promise<string | null> => SECRET;
const WAKES: BoxWakes = [
  {
    payload: "app",
    id: "w1",
    reason: "ci",
    expiresAt: "2026-11-25T12:00:00Z",
    on: { source: "github", repository: "acme/app", events: ["check_suite"] },
  },
  { payload: "app", id: "w2", reason: "g", expiresAt: "2026-11-25T12:00:00Z", on: { source: "generic", topic: "t" } },
];

function setup(wakes: BoxWakes = WAKES) {
  const seen = new Set<string>();
  const calls = { wakes: 0, firstDelivery: 0, requestWake: [] as Array<{ why: string; ids: ReadonlyArray<string> }> };
  const deps: HookDeps = {
    sources: [githubSource(secret), genericSource(secret)],
    wakes: async () => {
      calls.wakes += 1;
      return wakes;
    },
    firstDelivery: async (key) => {
      calls.firstDelivery += 1;
      return !seen.has(key) && Boolean(seen.add(key));
    },
    requestWake: async (why, ids) => {
      calls.requestWake.push({ why, ids });
    },
    now: () => NOW,
  };
  return { deps, calls };
}

function gh(over: { sig?: string; delivery?: string; body?: Uint8Array } = {}): HookRequest {
  const raw = over.body ?? new TextEncoder().encode(JSON.stringify({ repository: { full_name: "acme/app" } }));
  const sig = over.sig ?? `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
  return {
    method: "POST",
    path: "/v1/hooks/github",
    headers: {
      "x-github-event": "check_suite",
      "x-github-delivery": over.delivery ?? "d1",
      "x-hub-signature-256": sig,
    },
    rawBody: raw,
  };
}

function gen(over: { sig?: string } = {}): HookRequest {
  const raw = new TextEncoder().encode("{}");
  const stamp = String(Math.floor(NOW / 1000));
  const mac = createHmac("sha256", SECRET).update(`${stamp}.`).update(raw).digest("hex");
  return {
    method: "POST",
    path: "/v1/hooks/generic/t",
    headers: { "x-dozebox-timestamp": stamp, "x-dozebox-signature-256": over.sig ?? `sha256=${mac}` },
    rawBody: raw,
  };
}

describe("handleHook", () => {
  test("unknown route and wrong method answer 404", async () => {
    const { deps } = setup();
    assert.deepEqual(await handleHook(deps, { ...gh(), path: "/v1/hooks/nope" }), {
      status: 404,
      body: { error: { code: "not_found" } },
    });
    assert.equal((await handleHook(deps, { ...gh(), method: "GET" })).status, 404);
  });

  test("body over 64 KiB answers 413 before anything else", async () => {
    const { deps, calls } = setup();
    const ans = await handleHook(deps, gh({ body: new Uint8Array(64 * 1024 + 1) }));
    assert.deepEqual(ans, { status: 413, body: { error: { code: "too_large" } } });
    assert.equal(calls.wakes, 0);
  });

  for (const [name, req] of [
    ["github", () => gh({ sig: "sha256=deadbeef" })],
    ["generic", () => gen({ sig: `sha256=${"0".repeat(64)}` })],
  ] as const) {
    test(`bad ${name} signature answers 401 and touches nothing`, async () => {
      const { deps, calls } = setup();
      assert.deepEqual(await handleHook(deps, req()), { status: 401, body: { error: { code: "unauthorized" } } });
      assert.deepEqual(calls, { wakes: 0, firstDelivery: 0, requestWake: [] });
    });
  }

  test("a match requests one wake with the matching ids", async () => {
    const { deps, calls } = setup();
    assert.deepEqual(await handleHook(deps, gh()), { status: 202, body: { wake: true, why: "github:check_suite" } });
    assert.deepEqual(calls.requestWake, [{ why: "github:check_suite", ids: ["app/w1"] }]);
  });

  test("a generic match wakes too", async () => {
    const { deps, calls } = setup();
    assert.deepEqual(await handleHook(deps, gen()), { status: 202, body: { wake: true, why: "generic:t" } });
    assert.deepEqual(calls.requestWake[0]?.ids, ["app/w2"]);
  });

  test("a replayed delivery id is a duplicate", async () => {
    const { deps, calls } = setup();
    await handleHook(deps, gh());
    assert.deepEqual(await handleHook(deps, gh()), { status: 202, body: { wake: false, why: "duplicate" } });
    assert.equal(calls.requestWake.length, 1);
    assert.equal((await handleHook(deps, gh({ delivery: "d2" }))).status, 202);
    assert.equal(calls.requestWake.length, 2);
  });

  test("no match answers 202 wake:false without consuming the delivery", async () => {
    const { deps, calls } = setup([]);
    assert.deepEqual(await handleHook(deps, gh()), { status: 202, body: { wake: false, why: "no-matching-wake" } });
    assert.equal(calls.firstDelivery, 0);
    assert.equal(calls.requestWake.length, 0);
  });
});
