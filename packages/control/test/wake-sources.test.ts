// C5 wake sources: signature checks, match filter tables and the generic timestamp and size rules.
import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import type { BoxWakes, HookRequest } from "../src/ports/wakeSource.ts";
import { GENERIC_BODY_LIMIT_BYTES, GENERIC_SKEW_MS, genericSource } from "../src/wake/sources/generic.ts";
import { githubSource } from "../src/wake/sources/github.ts";

const NOW = Date.parse("2026-11-25T10:00:00Z");
const SECRET = "s3cret";
const FUTURE = "2026-11-25T12:00:00Z";
const PAST = "2026-11-25T09:00:00Z";
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const hmac = (data: string | Uint8Array): string => createHmac("sha256", SECRET).update(data).digest("hex");

type Wake = BoxWakes[number];
const wake = (on: unknown, expiresAt = FUTURE, id = "w1"): Wake => ({ payload: "app", id, reason: "r", on, expiresAt });

const GH_ON = {
  source: "github",
  repository: "Acme/App",
  events: ["check_suite", "pull_request"],
  number: 7,
  actions: ["completed"],
};

function ghReq(
  body: unknown,
  over: Partial<{ event: string; sig: string | null; delivery: string }> = {},
): HookRequest {
  const raw = enc(JSON.stringify(body));
  const headers: Record<string, string> = {
    "x-github-event": over.event ?? "check_suite",
    "x-github-delivery": over.delivery ?? "d-1",
  };
  if (over.sig !== null) headers["x-hub-signature-256"] = over.sig ?? `sha256=${hmac(raw)}`;
  return { method: "POST", path: "/v1/hooks/github", headers, rawBody: raw };
}

const ghBody = {
  action: "completed",
  repository: { full_name: "acme/app" },
  check_suite: { pull_requests: [{ number: 7 }] },
};
const secret = async (): Promise<string | null> => SECRET;

describe("github source verify", () => {
  const src = githubSource(secret);
  test("good signature", async () => assert.equal(await src.verify(ghReq(ghBody), NOW), true));
  test("bad signature", async () =>
    assert.equal(await src.verify(ghReq(ghBody, { sig: `sha256=${"0".repeat(64)}` }), NOW), false));
  test("wrong length signature", async () =>
    assert.equal(await src.verify(ghReq(ghBody, { sig: "sha256=ab" }), NOW), false));
  test("missing header", async () => assert.equal(await src.verify(ghReq(ghBody, { sig: null }), NOW), false));
  test("missing secret", async () =>
    assert.equal(await githubSource(async () => null).verify(ghReq(ghBody), NOW), false));
});

describe("github source match", () => {
  const src = githubSource(secret);
  const rows: ReadonlyArray<{ name: string; req: HookRequest; wakes: BoxWakes; hit: boolean }> = [
    { name: "all fields match", req: ghReq(ghBody), wakes: [wake(GH_ON)], hit: true },
    {
      name: "other repo",
      req: ghReq({ ...ghBody, repository: { full_name: "acme/other" } }),
      wakes: [wake(GH_ON)],
      hit: false,
    },
    { name: "other event", req: ghReq(ghBody, { event: "push" }), wakes: [wake(GH_ON)], hit: false },
    {
      name: "other number",
      req: ghReq({ ...ghBody, check_suite: { pull_requests: [{ number: 8 }] } }),
      wakes: [wake(GH_ON)],
      hit: false,
    },
    {
      name: "filter without number",
      req: ghReq({ ...ghBody, check_suite: {} }),
      wakes: [wake({ ...GH_ON, number: undefined })],
      hit: true,
    },
    {
      name: "pull_request number",
      req: ghReq({ action: "completed", repository: { full_name: "acme/app" }, number: 7 }, { event: "pull_request" }),
      wakes: [wake(GH_ON)],
      hit: true,
    },
    { name: "other action", req: ghReq({ ...ghBody, action: "requested" }), wakes: [wake(GH_ON)], hit: false },
    {
      name: "filter without actions",
      req: ghReq({ ...ghBody, action: "requested" }),
      wakes: [wake({ ...GH_ON, actions: undefined })],
      hit: true,
    },
    { name: "expired", req: ghReq(ghBody), wakes: [wake(GH_ON, PAST)], hit: false },
    { name: "other source", req: ghReq(ghBody), wakes: [wake({ ...GH_ON, source: "generic" })], hit: false },
    { name: "no filter", req: ghReq(ghBody), wakes: [wake(undefined)], hit: false },
    { name: "bad json", req: { ...ghReq(ghBody), rawBody: enc("{nope") }, wakes: [wake(GH_ON)], hit: false },
  ];
  for (const row of rows) {
    test(row.name, () => assert.equal(src.match(row.req, row.wakes, NOW).wake, row.hit));
  }

  test("ids and dedupe key cover every match", () => {
    const m = src.match(
      ghReq(ghBody, { delivery: "abc" }),
      [wake(GH_ON, FUTURE, "a"), wake(GH_ON, PAST, "b"), wake(GH_ON, FUTURE, "c")],
      NOW,
    );
    assert.deepEqual(m, {
      wake: true,
      why: "github:check_suite",
      wakeIds: ["app/a", "app/c"],
      dedupeKey: "github:abc",
    });
  });
});

const GEN_ON = { source: "generic", topic: "deploy" };

function genReq(
  body: string | Uint8Array,
  over: Partial<{ stamp: number; sig: string | null; path: string }> = {},
): HookRequest {
  const raw = typeof body === "string" ? enc(body) : body;
  const stamp = String(over.stamp ?? Math.floor(NOW / 1000));
  const mac = createHmac("sha256", SECRET).update(`${stamp}.`).update(raw).digest("hex");
  const headers: Record<string, string> = { "x-dozebox-timestamp": stamp };
  if (over.sig !== null) headers["x-dozebox-signature-256"] = over.sig ?? `sha256=${mac}`;
  return { method: "POST", path: over.path ?? "/v1/hooks/generic/deploy", headers, rawBody: raw };
}

describe("generic source verify", () => {
  const src = genericSource(secret);
  const sec = Math.floor(NOW / 1000);
  const rows: ReadonlyArray<{ name: string; req: HookRequest; ok: boolean }> = [
    { name: "good", req: genReq("{}"), ok: true },
    { name: "bad signature", req: genReq("{}", { sig: `sha256=${"0".repeat(64)}` }), ok: false },
    { name: "missing signature", req: genReq("{}", { sig: null }), ok: false },
    { name: "skew at the limit", req: genReq("{}", { stamp: sec - GENERIC_SKEW_MS / 1000 }), ok: true },
    { name: "too old", req: genReq("{}", { stamp: sec - GENERIC_SKEW_MS / 1000 - 1 }), ok: false },
    { name: "too far ahead", req: genReq("{}", { stamp: sec + GENERIC_SKEW_MS / 1000 + 1 }), ok: false },
    { name: "oversize body", req: genReq(new Uint8Array(GENERIC_BODY_LIMIT_BYTES + 1).fill(32)), ok: false },
    { name: "body at the limit", req: genReq(new Uint8Array(GENERIC_BODY_LIMIT_BYTES).fill(32)), ok: true },
  ];
  for (const row of rows) test(row.name, async () => assert.equal(await src.verify(row.req, NOW), row.ok));

  test("non-numeric timestamp and missing secret", async () => {
    const r = genReq("{}");
    assert.equal(await src.verify({ ...r, headers: { ...r.headers, "x-dozebox-timestamp": "abc" } }, NOW), false);
    assert.equal(await genericSource(async () => null).verify(r, NOW), false);
  });
});

describe("generic source match", () => {
  const src = genericSource(secret);
  const rows: ReadonlyArray<{ name: string; req: HookRequest; wakes: BoxWakes; hit: boolean }> = [
    { name: "topic matches", req: genReq("{}"), wakes: [wake(GEN_ON)], hit: true },
    { name: "other topic", req: genReq("{}", { path: "/v1/hooks/generic/other" }), wakes: [wake(GEN_ON)], hit: false },
    { name: "expired", req: genReq("{}"), wakes: [wake(GEN_ON, PAST)], hit: false },
    { name: "github filter", req: genReq("{}"), wakes: [wake(GH_ON)], hit: false },
    { name: "empty topic", req: genReq("{}", { path: "/v1/hooks/generic/" }), wakes: [wake(GEN_ON)], hit: false },
  ];
  for (const row of rows) test(row.name, () => assert.equal(src.match(row.req, row.wakes, NOW).wake, row.hit));

  test("dedupe key is the body digest", () => {
    const a = src.match(genReq('{"a":1}'), [wake(GEN_ON)], NOW);
    const b = src.match(genReq('{"a":2}'), [wake(GEN_ON)], NOW);
    assert.ok(a.wake && b.wake);
    assert.match(a.dedupeKey, /^generic:deploy:[0-9a-f]{64}$/);
    assert.notEqual(a.dedupeKey, b.dedupeKey);
  });
});
