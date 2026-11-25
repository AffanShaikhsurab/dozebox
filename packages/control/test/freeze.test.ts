// C6: the budget freeze judged from Spend. No data never freezes; the caller makes `freeze` idempotent.
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import type { SpendVerdict } from "@dozebox/core/caps";
import type { Spend } from "../src/ports/spend.ts";
import { checkBudgetFreeze, type FreezeDeps } from "../src/caps/freeze.ts";

const setup = (spend: Spend["monthToDate"]) => {
  const frozen: Array<{ verdict: SpendVerdict; token: number }> = [];
  const deps: FreezeDeps = {
    spend: { monthToDate: spend },
    policy: { monthlyBudgetUsd: 100 },
    freeze: async (verdict, token) => void frozen.push({ verdict, token }),
    now: () => 0,
  };
  return { deps, frozen };
};
const reading = (usd: number) => async () => ({ usd, asOf: 5 });

describe("checkBudgetFreeze", () => {
  test("no Budgets data -> unknown, no freeze", async () => {
    const { deps, frozen } = setup(async () => null);
    const v = await checkBudgetFreeze(deps, 1);
    assert.equal(v.level, "unknown");
    assert.equal(frozen.length, 0);
  });

  test("at the budget -> freeze called once with the verdict and token", async () => {
    const { deps, frozen } = setup(reading(100));
    const v = await checkBudgetFreeze(deps, 7);
    assert.equal(v.level, "freeze");
    assert.deepEqual(frozen, [{ verdict: v, token: 7 }]);
  });

  test("above the budget -> freeze", async () => {
    const { deps, frozen } = setup(reading(130));
    assert.equal((await checkBudgetFreeze(deps, 1)).freeze, true);
    assert.equal(frozen.length, 1);
  });

  test("warn level -> no freeze", async () => {
    const { deps, frozen } = setup(reading(85));
    assert.equal((await checkBudgetFreeze(deps, 1)).level, "warn");
    assert.equal(frozen.length, 0);
  });

  test("a spend read error is rethrown and nothing freezes", async () => {
    const { deps, frozen } = setup(async () => {
      throw new Error("budgets down");
    });
    await assert.rejects(checkBudgetFreeze(deps, 1), /budgets down/);
    assert.equal(frozen.length, 0);
  });
});
