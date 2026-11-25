import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeFakeClock, makeFakeSpotNotices } from "@dozebox/testkit/fakes";
import type { SpotAction } from "../src/ports/host.ts";
import { makeReclaim } from "../src/spot/reclaim.ts";
import { SPOT_POLL_MS, spotLoop } from "../src/spot/index.ts";

const signal = new AbortController().signal;

test("spotLoop calls onNotice once per distinct notice", async () => {
  const notices = makeFakeSpotNotices();
  const seen: SpotAction[] = [];
  const loop = spotLoop({ notices, now: () => 0, onNotice: async (n) => void seen.push(n) });
  assert.equal(loop.name, "spot");
  assert.equal(loop.everyMs, SPOT_POLL_MS);
  assert.equal(loop.immediate, true);
  await loop.tick(signal);
  assert.equal(seen.length, 0);
  notices.notice = { action: "terminate", at: 1000 };
  await loop.tick(signal);
  await loop.tick(signal);
  assert.equal(seen.length, 1);
  notices.notice = { action: "terminate", at: 2000 };
  await loop.tick(signal);
  assert.equal(seen.length, 2);
});

test("spotLoop propagates read errors", async () => {
  const loop = spotLoop({
    notices: { instanceAction: async () => Promise.reject(new Error("imds down")) },
    now: () => 0,
    onNotice: async () => {},
  });
  await assert.rejects(loop.tick(signal), /imds down/);
});

test("a notice publishes reclaim-notice, then parks at once with reason reclaim", async () => {
  const clock = makeFakeClock();
  const log: string[] = [];
  const reclaim = makeReclaim({
    publish: (name, data) => log.push(`${clock.now()} ${name} ${JSON.stringify(data)}`),
    park: async (reason, detail) => void log.push(`${clock.now()} park ${reason} ${detail}`),
    stopGraceSeconds: 60,
  });
  const at = clock.now() + 120_000;
  await reclaim({ action: "terminate", at });
  const t = clock.now();
  assert.deepEqual(log, [
    `${t} reclaim-notice {"terminationAt":"${new Date(at).toISOString()}","stopGraceSeconds":60}`,
    `${t} park reclaim spot terminate at ${new Date(at).toISOString()}`,
  ]);
});

test("a second notice while the first park runs does nothing", async () => {
  const gate = Promise.withResolvers<void>();
  const events: string[] = [];
  const reclaim = makeReclaim({
    publish: (name) => events.push(name),
    park: () => gate.promise.then(() => void events.push("parked")),
    stopGraceSeconds: 60,
  });
  const first = reclaim({ action: "stop", at: 1 });
  await reclaim({ action: "stop", at: 1 });
  gate.resolve();
  await first;
  assert.deepEqual(events, ["reclaim-notice", "parked"]);
});

