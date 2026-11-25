// The payload protocol server's conformance cases (part 4 §4.19), wire-level, for any server: the agent's routes
// (A2), the simulator's agent model (S1/S2), or a fake. `make` returns a fresh harness per case over this fixture:
// payloads `web` and `api`, agent version 1.2.3, `holdMaxSeconds` 28,800 for `web` and 3,600 for `api`, the clock at
// `T0`, accepting writes, and a park side that accepts.
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

export const PROTOCOL_T0 = Date.parse("2026-11-25T00:00:00.000Z");
const MIN = 60_000;

export type ProtocolSocket = { readonly kind: "payload"; readonly payload: string } | { readonly kind: "admin" };

export type ProtocolReply = {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>> | undefined;
};

export type ProtocolHarness = {
  /** One request; the default socket is payload `web`. */
  readonly call: (
    method: string,
    path: string,
    body?: unknown,
    opts?: { readonly socket?: ProtocolSocket; readonly headers?: Readonly<Record<string, string>> },
  ) => Promise<ProtocolReply>;
  /** Move the server's clock forward. */
  readonly advance: (ms: number) => void;
  /** Writes are refused with 503 while false (the box is parking). */
  readonly setAccepting: (accepting: boolean) => void;
  /** What the park side answers to an accepted `/v1/sleep`. */
  readonly setSleepAnswer: (a: { readonly accepted: boolean; readonly blockers: ReadonlyArray<string> }) => void;
  /** Attention handed to the forwarder, in order. */
  readonly sent: ReadonlyArray<{ readonly payload: string }>;
  /** `force` of each sleep handed to the park side. */
  readonly sleeps: ReadonlyArray<boolean>;
};

export const API: ProtocolSocket = { kind: "payload", payload: "api" };
const ADMIN: ProtocolSocket = { kind: "admin" };
export const at = (ms: number): string => new Date(ms).toISOString();
export const hold = (minutes: number, extra: Record<string, unknown> = {}) => ({
  reason: "work",
  until: at(PROTOCOL_T0 + minutes * MIN),
  ...extra,
});

export function err(res: ProtocolReply, status: number, code: string, field?: string): void {
  assert.equal(res.status, status, JSON.stringify(res.body));
  const e = (res.body as { error: { code: string; field?: string } }).error;
  assert.equal(e.code, code);
  if (field !== undefined) assert.equal(e.field, field);
}

/** Hold keys visible on the admin socket, as `<payload>/<id>` when the server says the payload, else `<id>`. */
export async function adminHolds(h: ProtocolHarness): Promise<string[]> {
  const list = (await h.call("GET", "/v1/holds", undefined, { socket: ADMIN })).body as {
    holds: Array<{ id: string; payload?: string }>;
  };
  return list.holds.map((x) => (x.payload === undefined ? x.id : `${x.payload}/${x.id}`)).toSorted();
}

/** Hello, status, holds, admin socket, beats, wakes, presence. Attention, health and sleep: `protocolServerSuiteMore`. */
export function protocolServerCore(name: string, make: () => Promise<ProtocolHarness>): void {
  describe(`${name}: hello and versions`, () => {
    it("hello names the payload, versions and limits", async () => {
      const h = await make();
      const res = await h.call("GET", "/v1/hello");
      assert.equal(res.status, 200);
      const b = res.body as { protocol: unknown; payload: unknown; agent: unknown; limits: Record<string, number> };
      assert.deepEqual(b.protocol, { major: 1, minor: 0 });
      assert.deepEqual(b.payload, { name: "web" });
      assert.deepEqual(b.agent, { version: "1.2.3" });
      assert.equal(b.limits["holdsPerPayload"], 64);
      assert.equal(b.limits["wakeHorizonSeconds"], 3_024_000);
    });

    it("hello reports the payload's own holdMaxSeconds", async () => {
      const h = await make();
      const b = (await h.call("GET", "/v1/hello", undefined, { socket: API })).body as {
        limits: Record<string, number>;
      };
      assert.equal(b.limits["holdMaxSeconds"], 3600);
    });

    it("status answers on both sockets", async () => {
      const h = await make();
      assert.equal((await h.call("GET", "/v1/status")).status, 200);
      assert.equal((await h.call("GET", "/v1/status", undefined, { socket: ADMIN })).status, 200);
    });

    it("/v2 is unsupported_version, an unknown /v1 path not_found, a wrong method bad_request", async () => {
      const h = await make();
      err(await h.call("GET", "/v2/hello"), 404, "unsupported_version");
      err(await h.call("GET", "/v1/nope"), 404, "not_found");
      err(await h.call("POST", "/v1/hello"), 400, "bad_request");
    });
  });

  describe(`${name}: holds`, () => {
    it("PUT twice keeps since and moves until", async () => {
      const h = await make();
      const a = (await h.call("PUT", "/v1/holds/run-42", hold(30))).body as { since: string };
      h.advance(MIN);
      const b = (await h.call("PUT", "/v1/holds/run-42", hold(40))).body as { since: string; until: string };
      assert.equal(b.since, a.since);
      assert.equal(b.until, at(PROTOCOL_T0 + 40 * MIN));
    });

    it("unknown, missing and out-of-range fields are refused with their field", async () => {
      const h = await make();
      err(await h.call("PUT", "/v1/holds/a", hold(5, { color: "red" })), 400, "unknown_field", "color");
      err(await h.call("PUT", "/v1/holds/a", { reason: "r" }), 400, "bad_request", "until");
      err(await h.call("PUT", "/v1/holds/a", undefined), 400, "bad_request");
      err(await h.call("PUT", "/v1/holds/a", ["x"]), 400, "bad_request");
      err(await h.call("PUT", "/v1/holds/a", hold(5, { maxSeconds: 10 })), 400, "invalid_value", "maxSeconds");
      err(await h.call("PUT", "/v1/holds/a", hold(5, { kind: "forever" })), 400, "invalid_value", "kind");
      err(
        await h.call("PUT", "/v1/holds/a", { reason: "", until: at(PROTOCOL_T0 + MIN) }),
        400,
        "invalid_value",
        "reason",
      );
      err(await h.call("PUT", "/v1/holds/a", hold(-1)), 400, "invalid_value", "until");
      err(await h.call("PUT", "/v1/holds/Upper", hold(5)), 400, "invalid_value", "id");
      err(await h.call("PUT", `/v1/holds/${"a".repeat(65)}`, hold(5)), 400, "invalid_value", "id");
    });

    it("the 65th hold is limit_exceeded (409)", async () => {
      const h = await make();
      for (let i = 0; i < 64; i++) assert.equal((await h.call("PUT", `/v1/holds/h${i}`, hold(5))).status, 200);
      err(await h.call("PUT", "/v1/holds/h64", hold(5)), 409, "limit_exceeded");
    });

    it("GET lists only the caller's live holds", async () => {
      const h = await make();
      await h.call("PUT", "/v1/holds/a", hold(5));
      await h.call("PUT", "/v1/holds/b", hold(1));
      await h.call("PUT", "/v1/holds/c", hold(5), { socket: API });
      h.advance(MIN);
      const list = (await h.call("GET", "/v1/holds")).body as { holds: Array<{ id: string }> };
      assert.deepEqual(
        list.holds.map((x) => x.id),
        ["a"],
      );
    });

    it("DELETE releases (204), an unknown id is not_found", async () => {
      const h = await make();
      await h.call("PUT", "/v1/holds/a", hold(5));
      const res = await h.call("DELETE", "/v1/holds/a");
      assert.equal(res.status, 204);
      assert.equal(res.body, undefined);
      err(await h.call("DELETE", "/v1/holds/a"), 404, "not_found");
    });

    it("writes while parking are 503 shutting_down (retryable), reads still work", async () => {
      const h = await make();
      h.setAccepting(false);
      const res = await h.call("PUT", "/v1/holds/a", hold(5));
      err(res, 503, "shutting_down");
      assert.equal((res.body as { error: { retryable: boolean } }).error.retryable, true);
      assert.equal((await h.call("GET", "/v1/holds")).status, 200);
    });
  });

  describe(`${name}: admin socket`, () => {
    it("writes need the payload header; with it they act as that payload; an unknown payload is refused", async () => {
      const h = await make();
      err(await h.call("PUT", "/v1/holds/a", hold(5), { socket: ADMIN }), 400, "bad_request", "x-dozebox-payload");
      const as = (p: string) => ({ socket: ADMIN, headers: { "x-dozebox-payload": p } });
      assert.equal((await h.call("PUT", "/v1/holds/a", hold(5), as("api"))).status, 200);
      const api = (await h.call("GET", "/v1/holds", undefined, { socket: API })).body as {
        holds: Array<{ id: string }>;
      };
      assert.deepEqual(
        api.holds.map((x) => x.id),
        ["a"],
      );
      err(await h.call("PUT", "/v1/holds/a", hold(5), as("nope")), 400, "invalid_value");
    });

    it("admin GET without the header lists every payload", async () => {
      const h = await make();
      await h.call("PUT", "/v1/holds/a", hold(5));
      await h.call("PUT", "/v1/holds/b", hold(5), { socket: API });
      assert.equal((await adminHolds(h)).length, 2);
    });
  });
}
