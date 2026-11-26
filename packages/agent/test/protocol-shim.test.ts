import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SHIM_COMMANDS } from "../src/protocol/shim-commands.ts";
import { parseShim, shimMain, type ShimCall } from "../src/protocol/shim.ts";

const T0 = Date.parse("2026-11-25T00:00:00.000Z");

describe("box shims", () => {
  it("hold --for becomes a PUT with until = now + duration", () => {
    assert.deepEqual(
      parseShim(["hold", "ci-7", "--payload", "web", "--reason", "CI job", "--for", "30m", "--wait"], T0),
      {
        method: "PUT",
        path: "/v1/holds/ci-7",
        payload: "web",
        body: { reason: "CI job", until: "2026-11-25T00:30:00.000Z", kind: "wait" },
      },
    );
  });

  it("hold --until and --max pass through; --release is a DELETE", () => {
    const c = parseShim(
      ["hold", "a", "--payload", "web", "--reason", "r", "--until", "2026-11-25T02:00:00Z", "--max", "600"],
      T0,
    );
    assert.deepEqual(c.body, { reason: "r", until: "2026-11-25T02:00:00Z", kind: "work", maxSeconds: 600 });
    assert.deepEqual(parseShim(["hold", "a", "--payload", "web", "--release"], T0), {
      method: "DELETE",
      path: "/v1/holds/a",
      payload: "web",
    });
  });

  it("wake-request --at, and --cancel", () => {
    assert.deepEqual(
      parseShim(["wake-request", "nightly", "--payload", "web", "--reason", "n", "--at", "2026-11-26T02:00:00Z"], T0),
      {
        method: "PUT",
        path: "/v1/wakes/nightly",
        payload: "web",
        body: { reason: "n", at: "2026-11-26T02:00:00Z" },
      },
    );
    assert.equal(parseShim(["wake-request", "nightly", "--payload", "web", "--cancel"], T0).method, "DELETE");
  });

  it("the documented command list is the shim's command list", () => {
    assert.deepEqual(
      SHIM_COMMANDS.map((c) => c.name),
      ["hold", "wake-request"],
    );
    for (const c of SHIM_COMMANDS) {
      const argv =
        c.name === "hold"
          ? ["hold", "a", "--payload", "web", "--reason", "r", "--for", "1m"]
          : ["wake-request", "a", "--payload", "web", "--reason", "r", "--at", "2026-11-26T00:00:00Z"];
      assert.doesNotThrow(() => parseShim(argv, T0), c.name);
    }
  });

  it("usage errors exit 2 without calling the socket", async () => {
    const err: string[] = [];
    const calls: ShimCall[] = [];
    const io = { out: () => {}, err: (s: string) => void err.push(s), now: () => T0 };
    const fake = async (c: ShimCall) => {
      calls.push(c);
      return { status: 200, text: "{}" };
    };
    for (const argv of [
      ["hold"],
      ["hold", "a", "--reason", "r", "--for", "1m"],
      ["hold", "a", "--payload", "web", "--reason", "r", "--for", "soon"],
      ["nap", "a"],
    ]) {
      assert.equal(await shimMain(argv, io, fake), 2, argv.join(" "));
    }
    assert.equal(calls.length, 0);
    assert.equal(err.length, 4);
  });

  it("exit 0 on 2xx and 1 on an error answer, printing the body", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s), now: () => T0 };
    const argv = ["hold", "a", "--payload", "web", "--reason", "r", "--for", "1m"];
    assert.equal(await shimMain(argv, io, async () => ({ status: 200, text: '{"id":"a"}' })), 0);
    assert.equal(await shimMain(argv, io, async () => ({ status: 409, text: '{"error":{}}' })), 1);
    assert.equal(await shimMain(argv, io, async () => Promise.reject(new Error("ECONNREFUSED"))), 1);
    assert.deepEqual(out, ['{"id":"a"}\n']);
    assert.deepEqual(err, ['{"error":{}}\n', "dozebox: ECONNREFUSED\n"]);
  });
});
