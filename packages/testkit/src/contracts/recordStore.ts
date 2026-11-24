// The `recordStore` contract: records under one box root (put, get, read all by path, delete, size limits, tiers).
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import type { RecordWriter } from "@dozebox/agent/ports/records";
import type { RecordStore } from "@dozebox/control/ports/records";
import { rejectsWith, type ContractOptions } from "./support.ts";

export type RecordHarness = {
  /** Writes under a fresh box root: the control function's store, or the agent's writer. */
  readonly writer: RecordWriter;
  /** Reads the same root. */
  readonly reader: Pick<RecordStore, "readAll" | "get">;
  /** Calls that reached the target so far (to prove a refusal happened before any call). */
  readonly calls: () => number;
  readonly inject: (op: "put" | "get", name: string, status: number) => void;
};

export function recordStoreContract(
  name: string,
  make: () => Promise<RecordHarness>,
  opts: ContractOptions = {},
): void {
  describe(`recordStore: ${name}`, { skip: opts.skip ?? false }, () => {
    test("put then get returns the value; a missing record is null", async () => {
      const h = await make();
      await h.writer.put("rec/serving", '{"v":1}', { tier: "Standard" });
      const r = await h.reader.get("rec/serving");
      assert.equal(r?.value, '{"v":1}');
      assert.equal(r?.name, "rec/serving");
      assert.ok(Number.isFinite(r?.modifiedAt));
      assert.equal(await h.reader.get("rec/last-error"), null);
    });

    test("put overwrites", async () => {
      const h = await make();
      await h.writer.put("rec/serving", "one", { tier: "Standard" });
      await h.writer.put("rec/serving", "two", { tier: "Standard" });
      assert.equal((await h.reader.get("rec/serving"))?.value, "two");
    });

    test("readAll returns every record under the root, past one page of results", async () => {
      const h = await make();
      const names = Array.from({ length: 12 }, (_, i) => `rec/p${String(i).padStart(2, "0")}`);
      for (const n of names) await h.writer.put(n, n, { tier: "Standard" });
      await h.writer.put("fence/sleep-requested", "f", { tier: "Standard" });
      const all = await h.reader.readAll();
      assert.deepEqual(all.map((r) => r.name).toSorted(), [...names, "fence/sleep-requested"].toSorted());
      assert.equal(all.find((r) => r.name === "rec/p03")?.value, "rec/p03");
    });

    test("an Advanced record holds 8 KiB", async () => {
      const h = await make();
      await h.writer.put("rec/liveness", "x".repeat(8192), { tier: "Advanced" });
      assert.equal((await h.reader.get("rec/liveness"))?.value.length, 8192);
    });

    test("over the tier's limit is refused before the call", async () => {
      const h = await make();
      const before = h.calls();
      await rejectsWith(h.writer.put("rec/last-error", "x".repeat(4097), { tier: "Standard" }), "invalid_input", false);
      await rejectsWith(h.writer.put("rec/liveness", "x".repeat(8193), { tier: "Advanced" }), "invalid_input", false);
      await rejectsWith(h.writer.put("../escape", "x", { tier: "Standard" }), "invalid_input", false);
      assert.equal(h.calls(), before, "no call reached the target");
      assert.equal(await h.reader.get("rec/last-error"), null);
    });

    test("delete removes; deleting a missing record is not an error", async () => {
      const h = await make();
      await h.writer.put("rec/last-words", "w", { tier: "Standard" });
      await h.writer.delete("rec/last-words");
      assert.equal(await h.reader.get("rec/last-words"), null);
      await h.writer.delete("rec/last-words");
    });

    test("put throttled -> aws_throttled; get denied -> aws_denied", async () => {
      const h = await make();
      h.inject("put", "ThrottlingException", 400);
      await rejectsWith(h.writer.put("rec/serving", "x", { tier: "Standard" }), "aws_throttled", true);
      h.inject("get", "AccessDeniedException", 400);
      await rejectsWith(h.reader.get("rec/serving"), "aws_denied", false);
    });
  });
}
