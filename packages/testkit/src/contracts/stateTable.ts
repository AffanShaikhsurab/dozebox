// The `stateTable` contract: the reconcile lease with a fencing token, fenced writes and idempotency keys.
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import type { StateTable } from "@dozebox/control/ports/state";
import { fresh, rejectsWith, type ContractOptions } from "./support.ts";

export type StateHarness = {
  readonly table: StateTable;
  /** Move the table's clock (the one putIfAbsent reads) forward. */
  readonly pass: (ms: number) => Promise<void>;
  /** The table's clock, in epoch ms. */
  readonly now: () => number;
  readonly inject: (op: "write" | "get", name: string, status: number) => void;
};

const TTL = 45_000;

export function stateTableContract(name: string, make: () => Promise<StateHarness>, opts: ContractOptions = {}): void {
  describe(`stateTable: ${name}`, { skip: opts.skip ?? false }, () => {
    test("a free lease is granted with a token", async () => {
      const h = await make();
      const t0 = h.now();
      const lease = await h.table.acquireLease(fresh("lease"), "tick-a", TTL, t0);
      assert.ok(lease);
      assert.deepEqual([lease.holder, lease.expiresAt], ["tick-a", t0 + TTL]);
      assert.ok(Number.isInteger(lease.token) && lease.token >= 1);
    });

    test("a held lease is refused to another holder until it expires; each grant has a larger token", async () => {
      const h = await make();
      const n = fresh("lease");
      const t0 = h.now();
      const a = await h.table.acquireLease(n, "tick-a", TTL, t0);
      assert.ok(a);
      assert.equal(await h.table.acquireLease(n, "tick-b", TTL, t0 + 1_000), null);
      const renewed = await h.table.acquireLease(n, "tick-a", TTL, t0 + 2_000);
      assert.ok(renewed && renewed.token > a.token);
      const b = await h.table.acquireLease(n, "tick-b", TTL, t0 + 2_000 + TTL + 1);
      assert.ok(b && b.token > renewed.token);
      assert.equal(b.holder, "tick-b");
    });

    test("two concurrent acquires of a free lease -> exactly one granted", async () => {
      const h = await make();
      const n = fresh("lease");
      const t0 = h.now();
      const results = await Promise.all([
        h.table.acquireLease(n, "tick-a", TTL, t0),
        h.table.acquireLease(n, "tick-b", TTL, t0),
      ]);
      assert.equal(results.filter((r) => r !== null).length, 1, JSON.stringify(results));
    });

    test("putFenced keeps the newest token's value and refuses an older token with lease_lost", async () => {
      const h = await make();
      const key = fresh("desired");
      await h.table.putFenced(key, { state: "awake" }, 5);
      await h.table.putFenced(key, { state: "awake", n: 2 }, 5);
      await h.table.putFenced(key, { state: "asleep" }, 6);
      await rejectsWith(h.table.putFenced(key, { state: "awake" }, 4), "lease_lost", false);
      assert.deepEqual(await h.table.get(key), { state: "asleep" });
    });

    test("putIfAbsent writes once, and again only after its ttl passed", async () => {
      const h = await make();
      const key = fresh("idem");
      assert.equal(await h.table.putIfAbsent(key, { accepted: 1 }, 2), "written");
      assert.equal(await h.table.putIfAbsent(key, { accepted: 2 }, 2), "exists");
      assert.deepEqual(await h.table.get(key), { accepted: 1 });
      await h.pass(3_100);
      assert.equal(await h.table.get(key), null, "an expired entry reads as absent");
      assert.equal(await h.table.putIfAbsent(key, { accepted: 3 }, 2), "written");
      assert.deepEqual(await h.table.get(key), { accepted: 3 });
    });

    test("get of a key never written is null", async () => {
      const h = await make();
      assert.equal(await h.table.get(fresh("nothing")), null);
    });

    test("write throttled -> aws_throttled; get unavailable -> aws_unavailable", async () => {
      const h = await make();
      h.inject("write", "ProvisionedThroughputExceededException", 400);
      await rejectsWith(h.table.putFenced(fresh("k"), 1, 1), "aws_throttled", true);
      h.inject("get", "InternalServerError", 500);
      await rejectsWith(h.table.get(fresh("k")), "aws_unavailable", true);
    });
  });
}
