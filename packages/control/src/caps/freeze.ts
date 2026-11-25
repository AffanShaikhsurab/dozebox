// C6: budget freeze from Spend (core judgeSpend). Null Budgets data means no freeze; the awake caps (C3) still apply.
import { judgeSpend } from "@dozebox/core/caps";
import type { SpendPolicy, SpendVerdict } from "@dozebox/core/caps";
import type { Spend } from "../ports/spend.ts";

export type FreezeDeps = {
  readonly spend: Spend;
  readonly policy: SpendPolicy;
  /** Write the freeze flag (`ctl/frozen`) and page once per freeze. */
  readonly freeze: (verdict: SpendVerdict, token: number) => Promise<void>;
  readonly now: () => number;
};

/** A spend read error propagates: the tick logs it and tries again next time. */
export async function checkBudgetFreeze(deps: FreezeDeps, token: number): Promise<SpendVerdict> {
  const verdict = judgeSpend(await deps.spend.monthToDate(), deps.policy);
  if (verdict.freeze) await deps.freeze(verdict, token);
  return verdict;
}
