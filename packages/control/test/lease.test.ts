// C2 lease: two acquires -> one wins; a stale token cannot write; an expired lease refuses its own writes.
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { makeFakeAws } from "@dozebox/testkit/fakes";
import { LEASE_MIN_LEFT_MS, LEASE_TTL_MS, makeLeaseKeeper } from "../src/state/lease.ts";

const lost = (e: unknown): boolean => e instanceof RunnerError && e.code === "lease_lost";

function world() {
  const aws = makeFakeAws();
  const keeper = (holder: string) => makeLeaseKeeper({ state: aws.dynamodb.table, clock: aws.clock, holder });
  return { aws, a: keeper("tick-a"), b: keeper("tick-b") };
}

describe("lease", () => {
  test("two concurrent acquires: exactly one wins", async () => {
    const { a, b } = world();
    const [x, y] = await Promise.all([a.acquire("reconcile"), b.acquire("reconcile")]);
    assert.equal([x, y].filter((l) => l !== null).length, 1);
  });

  test("the holder may renew; the token grows on every grant", async () => {
    const { aws, a, b } = world();
    const first = await a.acquire("reconcile");
    aws.clock.advance(1_000);
    assert.equal(await b.acquire("reconcile"), null);
    const again = await a.acquire("reconcile");
    assert.ok(first !== null && again !== null);
    assert.ok(again.lease.token > first.lease.token);
  });

  test("a stale token cannot write after a newer holder wrote the key", async () => {
    const { aws, a, b } = world();
    const old = await a.acquire("reconcile");
    aws.clock.advance(LEASE_TTL_MS + 1);
    const fresh = await b.acquire("reconcile");
    assert.ok(old !== null && fresh !== null);
    assert.ok(fresh.lease.token > old.lease.token);
    await fresh.putFenced("caps", { n: 2 });
    await assert.rejects(old.putFenced("caps", { n: 1 }), lost);
    assert.deepEqual(await aws.dynamodb.table.get("caps"), { n: 2 });
  });

  test("an expired lease refuses its own writes even to keys no one else wrote", async () => {
    const { aws, a } = world();
    const held = await a.acquire("reconcile");
    assert.ok(held !== null);
    await held.putFenced("k", 1);
    aws.clock.advance(LEASE_TTL_MS);
    await assert.rejects(held.putFenced("k", 2), lost);
    assert.equal(await aws.dynamodb.table.get("k"), 1);
  });

  test("remainingMs and mayContinue follow the clock", async () => {
    const { aws, a } = world();
    const held = await a.acquire("reconcile");
    assert.ok(held !== null);
    const t0 = aws.clock.now();
    assert.equal(held.remainingMs(t0), LEASE_TTL_MS);
    assert.equal(held.mayContinue(t0 + LEASE_TTL_MS - LEASE_MIN_LEFT_MS), true);
    assert.equal(held.mayContinue(t0 + LEASE_TTL_MS - LEASE_MIN_LEFT_MS + 1), false);
    assert.equal(held.remainingMs(t0 + LEASE_TTL_MS + 5), 0);
  });
});
