// The Clock port's contract. Every Clock implementation (the fake here, the agent's real one) must pass it.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Clock } from "@dozebox/core/time";

export type ClockDriver = {
  readonly clock: Clock;
  /** Let `ms` of the clock's time pass, then let pending callbacks run. */
  readonly pass: (ms: number) => Promise<void>;
};

const settled = async <T>(p: Promise<T>): Promise<"resolved" | "rejected" | "pending"> => {
  let state: "resolved" | "rejected" | "pending" = "pending";
  p.then(
    () => (state = "resolved"),
    () => (state = "rejected"),
  );
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return state;
};

/** Register the Clock contract tests under `name`. `make` returns a fresh driver for each case. */
export function clockContract(name: string, make: () => ClockDriver): void {
  test(`${name}: now() does not go backwards and moves with time`, async () => {
    const { clock, pass } = make();
    const a = clock.now();
    await pass(50);
    const b = clock.now();
    assert.ok(b - a >= 50, `moved ${b - a} ms`);
  });

  test(`${name}: sleep(ms) resolves after ms and not before`, async () => {
    const { clock, pass } = make();
    const p = clock.sleep(40);
    await pass(10);
    assert.equal(await settled(p), "pending");
    await pass(40);
    assert.equal(await settled(p), "resolved");
  });

  test(`${name}: sleep rejects with the signal's reason when aborted`, async () => {
    const { clock } = make();
    const c = new AbortController();
    const p = clock.sleep(1_000, c.signal);
    c.abort(new Error("stop"));
    await assert.rejects(p, /stop/);
  });

  test(`${name}: sleep with an already aborted signal rejects at once`, async () => {
    const { clock } = make();
    await assert.rejects(clock.sleep(1_000, AbortSignal.abort(new Error("already"))), /already/);
  });

  test(`${name}: timeout(ms) aborts with a TimeoutError after ms`, async () => {
    const { clock, pass } = make();
    const s = clock.timeout(30);
    await pass(5);
    assert.equal(s.aborted, false);
    await pass(40);
    assert.equal(s.aborted, true);
    assert.equal((s.reason as DOMException).name, "TimeoutError");
  });
}
