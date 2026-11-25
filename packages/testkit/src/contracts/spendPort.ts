// The `spendPort` contract: month-to-date spend from the billing data, null (never 0) before there is any.
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import type { Spend } from "@dozebox/control/ports/spend";
import { gap, rejectsWith, type ContractOptions } from "./support.ts";

export type SpendHarness = {
  /** A Spend reading a budget seeded with `usd` of actual spend, or with no calculated spend at all (null). */
  readonly spendWith: (usd: number | null) => Promise<Spend>;
  readonly inject: (spend: Spend, name: string, status: number) => void;
};

export function spendPortContract(name: string, make: () => Promise<SpendHarness>, opts: ContractOptions = {}): void {
  describe(`spendPort: ${name}`, { skip: opts.skip ?? false }, () => {
    test("month-to-date spend in USD with the time it was computed", async () => {
      const h = await make();
      const r = await (await h.spendWith(3.21)).monthToDate();
      assert.ok(r);
      assert.equal(r.usd, 3.21);
      assert.ok(Number.isFinite(r.asOf));
    });

    test("no calculated spend yet -> null, not 0", gap(opts.gaps, "noData"), async () => {
      const h = await make();
      assert.equal(await (await h.spendWith(null)).monthToDate(), null);
    });

    test("throttled -> aws_throttled; denied -> aws_denied", async () => {
      const h = await make();
      const s = await h.spendWith(1);
      h.inject(s, "ThrottlingException", 400);
      await rejectsWith(s.monthToDate(), "aws_throttled", true);
      h.inject(s, "AccessDeniedException", 400);
      await rejectsWith(s.monthToDate(), "aws_denied", false);
    });
  });
}
