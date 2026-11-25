// makeCoalescingPublisher: liveness within 10 s of a change and every 5 min, one write in flight, backoff, flush.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { makeFakeClock } from "@dozebox/testkit/fakes";
import { LIVENESS_CHANGE_MS, LIVENESS_EVERY_MS, makeCoalescingPublisher } from "../src/records/coalesce.ts";
import type { RecordPublisher } from "../src/records/publish.ts";
import { flush } from "./support.ts";

type Put = { readonly name: string; readonly body: unknown };

function setup(opts: { readonly rand?: number; readonly fail?: (n: number, p: Put) => Error | null } = {}) {
  const clock = makeFakeClock();
  const puts: Put[] = [];
  const gates: Array<() => void> = [];
  let hold = false;
  const publisher: RecordPublisher = {
    put: async (name: string, body: unknown) => {
      const p = { name, body };
      const err = opts.fail?.(puts.length, p) ?? null;
      puts.push(p);
      if (hold) await new Promise<void>((r) => gates.push(r));
      if (err) throw err;
    },
    delete: async () => {},
    lastError: async () => {},
  } as RecordPublisher;
  const c = makeCoalescingPublisher({ publisher, clock, rand: () => opts.rand ?? 0.5 });
  const step = async (ms: number) => {
    clock.advance(ms);
    await flush();
  };
  return {
    c,
    clock,
    puts,
    step,
    hold: (v: boolean) => (hold = v),
    release: async () => {
      gates.splice(0).forEach((r) => r());
      await flush();
    },
  };
}

const live = (n: number) => ({ name: "web", n }) as never;
const bodies = (puts: ReadonlyArray<Put>) => puts.map((p) => (p.body as { n: number }).n);

test("a liveness change is written within 10 s, not before", async () => {
  const s = setup();
  s.c.offer("rec/liveness", live(1));
  await s.step(LIVENESS_CHANGE_MS - 1);
  assert.equal(s.puts.length, 0);
  await s.step(1);
  assert.deepEqual(bodies(s.puts), [1]);
});

test("two changes in 3 s make one write with the newest body", async () => {
  const s = setup();
  s.c.offer("rec/liveness", live(1));
  await s.step(3_000);
  s.c.offer("rec/liveness", live(2));
  await s.step(LIVENESS_CHANGE_MS);
  assert.deepEqual(bodies(s.puts), [2]);
});

test("an unchanged body is not written again, except liveness every 5 min", async () => {
  const s = setup();
  s.c.offer("rec/liveness", live(1));
  s.c.offer("rec/wakes", { wakes: [] } as never);
  await s.step(LIVENESS_CHANGE_MS);
  assert.equal(s.puts.length, 2);
  s.c.offer("rec/liveness", live(1));
  s.c.offer("rec/wakes", { wakes: [] } as never);
  await s.step(LIVENESS_CHANGE_MS);
  assert.equal(s.puts.length, 2);
  await s.step(LIVENESS_EVERY_MS - LIVENESS_CHANGE_MS);
  assert.deepEqual(
    s.puts.map((p) => p.name),
    ["rec/liveness", "rec/wakes", "rec/liveness"],
  );
  await s.step(LIVENESS_EVERY_MS);
  assert.equal(s.puts.filter((p) => p.name === "rec/liveness").length, 3);
  assert.equal(s.puts.filter((p) => p.name === "rec/wakes").length, 1);
});

test("one write in flight per record; an offer during a write goes after it", async () => {
  const s = setup();
  s.hold(true);
  s.c.offer("rec/liveness", live(1));
  await s.step(LIVENESS_CHANGE_MS);
  s.c.offer("rec/liveness", live(2));
  await s.step(LIVENESS_CHANGE_MS);
  assert.deepEqual(bodies(s.puts), [1]);
  s.hold(false);
  await s.release();
  await s.step(LIVENESS_CHANGE_MS);
  assert.deepEqual(bodies(s.puts), [1, 2]);
});

test("a throttled write backs off with full jitter and writes the newest body", async () => {
  const s = setup({
    rand: 0.5,
    fail: (n) => (n === 0 ? new RunnerError("aws_throttled", true, "slow down") : null),
  });
  s.c.offer("rec/liveness", live(1));
  await s.step(LIVENESS_CHANGE_MS);
  assert.deepEqual(bodies(s.puts), [1]);
  s.c.offer("rec/liveness", live(2));
  await s.step(499);
  assert.equal(s.puts.length, 1);
  await s.step(1);
  assert.deepEqual(bodies(s.puts), [1, 2]);
});

test("backoff doubles per failure and is capped at 60 s", async () => {
  const s = setup({ rand: 1, fail: () => new RunnerError("aws_throttled", true, "slow down") });
  s.c.offer("rec/liveness", live(1));
  await s.step(LIVENESS_CHANGE_MS);
  for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
    const before = s.puts.length;
    await s.step(wait - 1);
    assert.equal(s.puts.length, before, `not before ${wait}`);
    await s.step(1);
    assert.equal(s.puts.length, before + 1, `at ${wait}`);
  }
});

test("a non-retryable failure drops that body; the next change writes again", async () => {
  const s = setup({ fail: (n) => (n === 0 ? new RunnerError("invalid_input", false, "too big") : null) });
  s.c.offer("rec/wakes", { n: 1 } as never);
  await s.step(LIVENESS_CHANGE_MS);
  await s.step(5 * 60_000);
  assert.equal(s.puts.length, 1);
  s.c.offer("rec/wakes", { n: 2 } as never);
  await s.step(LIVENESS_CHANGE_MS);
  assert.deepEqual(bodies(s.puts), [1, 2]);
});

test("flush writes every pending body now and waits for writes in flight", async () => {
  const s = setup();
  s.c.offer("rec/liveness", live(1));
  s.c.offer("rec/wakes", { n: 7 } as never);
  await s.c.flush(new AbortController().signal);
  assert.deepEqual(s.puts.map((p) => p.name).toSorted(), ["rec/liveness", "rec/wakes"]);
  await s.step(LIVENESS_CHANGE_MS);
  assert.equal(s.puts.length, 2);
});

test("flush waits for a write in flight", async () => {
  const s = setup();
  s.hold(true);
  s.c.offer("rec/liveness", live(1));
  await s.step(LIVENESS_CHANGE_MS);
  let done = false;
  const f = s.c.flush(new AbortController().signal).then(() => (done = true));
  await flush();
  assert.equal(done, false);
  s.hold(false);
  await s.release();
  await f;
  assert.equal(done, true);
});
