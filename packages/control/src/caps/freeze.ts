// C6: budget freeze from Spend (core judgeSpend). Null Budgets data means no freeze; the awake caps (C3) still apply.
import type { SpendPolicy, SpendVerdict } from "@dozebox/core/caps";
import type { Spend } from "../ports/spend.ts";

export type FreezeDeps = {
  readonly spend: Spend;
  readonly policy: SpendPolicy;
  /** Write the freeze flag (`ctl/frozen`) and page once per freeze. */
  readonly freeze: (verdict: SpendVerdict, token: number) => Promise<void>;
  readonly now: () => number;
};

export function checkBudgetFreeze(_deps: FreezeDeps, _token: number): Promise<SpendVerdict> {
  throw new Error("not implemented: C6 checkBudgetFreeze");
}
