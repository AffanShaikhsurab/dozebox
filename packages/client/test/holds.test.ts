import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { HoldInput } from "@dozebox/protocol/v1";
import { makeClient } from "../src/client.ts";
import { makeKeepHold, type Every } from "../src/holds.ts";
import { DozeboxError } from "../src/index.ts";
import { errorBody, reply, startFake } from "./fake.ts";

function manualTimer(): { every: Every; tick: () => void; intervals: number[]; cancelled: () => boolean } {
  let fn: (() => void) | undefined;
  let cancelled = false;
  const intervals: number[] = [];
  return {
    every: (f, ms) => {
      fn = f;
      intervals.push(ms);
      return () => {
        cancelled = true;
      };
    },
    tick: () => fn?.(),
    intervals,
    cancelled: () => cancelled,
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("keepHold puts now + forSeconds, renews on every tick, and stop releases", async () => {
  const timer = manualTimer();
  let clock = Date.parse("2026-11-24T21:00:00.000Z");
  const puts: HoldInput[] = [];
  const released: string[] = [];
  const keep = makeKeepHold({
    hold: async (_id, input) => void puts.push(input),
    release: async (id) => void released.push(id),
    every: timer.every,
    now: () => clock,
  });
  const kept = keep("run-1", { reason: "run 1", forSeconds: 90, kind: "wait" });
  assert.deepEqual(timer.intervals, [30_000]);
  clock += 30_000;
  timer.tick();
  clock += 30_000;
  timer.tick();
  await kept.stop();
  assert.deepEqual(
    puts.map((p) => p.until),
    ["2026-11-24T21:01:30.000Z", "2026-11-24T21:02:00.000Z", "2026-11-24T21:02:30.000Z"],
  );
  assert.equal(puts[0]?.kind, "wait");
  assert.deepEqual(released, ["run-1"]);
  assert.equal(timer.cancelled(), true);
  timer.tick();
  await flush();
  assert.equal(puts.length, 3);
  await kept.stop();
  assert.deepEqual(released, ["run-1"]);
});

test("keepHold honours renewEverySeconds, omits kind by default, and survives a failed renewal", async () => {
  const timer = manualTimer();
  let fail = true;
  const puts: HoldInput[] = [];
  const keep = makeKeepHold({
    hold: async (_id, input) => {
      puts.push(input);
      if (fail) throw new DozeboxError("transport", "down", 0, true);
    },
    release: async () => undefined,
    every: timer.every,
    now: () => 0,
  });
  const kept = keep("h", { reason: "r", forSeconds: 600, renewEverySeconds: 5 });
  assert.deepEqual(timer.intervals, [5000]);
  assert.equal("kind" in (puts[0] ?? {}), false);
  await flush();
  fail = false;
  timer.tick();
  await kept.stop();
  assert.equal(puts.length, 2);
});

test("stop ignores a hold the agent already dropped, and reports other release errors", async () => {
  const gone = makeKeepHold({
    hold: async () => undefined,
    release: async () => {
      throw new DozeboxError("not_found", "gone", 404, false);
    },
    every: manualTimer().every,
    now: () => 0,
  });
  await gone("h", { reason: "r", forSeconds: 60 }).stop();
  const broken = makeKeepHold({
    hold: async () => undefined,
    release: async () => {
      throw new DozeboxError("transport", "down", 0, true);
    },
    every: manualTimer().every,
    now: () => 0,
  });
  await assert.rejects(broken("h", { reason: "r", forSeconds: 60 }).stop(), DozeboxError);
});

test("keepHold through the client renews over the socket and releases on stop", async (t) => {
  const fake = await startFake(t, (req, res) =>
    req.method === "DELETE"
      ? reply(res, 204)
      : reply(res, 200, {
          id: "run-1",
          reason: "r",
          kind: "work",
          since: "",
          requestedUntil: "",
          until: "",
          clamped: false,
        }),
  );
  const timer = manualTimer();
  const client = makeClient({ socketPath: fake.socketPath, every: timer.every, now: () => 0 });
  const kept = client.keepHold("run-1", { reason: "r", forSeconds: 60 });
  await flush();
  timer.tick();
  await kept.stop();
  assert.deepEqual(
    fake.seen.map((s) => `${s.method} ${s.url}`),
    ["PUT /v1/holds/run-1", "PUT /v1/holds/run-1", "DELETE /v1/holds/run-1"],
  );
  assert.deepEqual(fake.seen[0]?.body, { reason: "r", until: "1970-01-01T00:01:00.000Z" });
});

test("a retryable error on renewal is retried by the call layer", async (t) => {
  let n = 0;
  const fake = await startFake(t, (req, res) =>
    req.method === "DELETE"
      ? reply(res, 204)
      : ++n === 1
        ? reply(res, 503, errorBody("shutting_down", true))
        : reply(res, 200, {}),
  );
  const client = makeClient({ socketPath: fake.socketPath, every: manualTimer().every, delay: async () => undefined });
  await client.keepHold("h", { reason: "r", forSeconds: 60 }).stop();
  assert.equal(fake.seen.length, 3);
});
