// AWS adapter for month-to-date spend: DescribeBudget on the box's budget (`<name>-monthly`, Terraform T5), its
// CalculatedSpend.ActualSpend in USD. Budgets data is updated up to three times a day, 8-12 hours apart (notes/06b
// §1.16), so this is the backstop, not the cap. A budget with no calculated spend yet (a new budget, a new month)
// reads as null, never 0: zero would claim a fresh "nothing spent" reading. `asOf` is the budget's LastUpdatedTime;
// when the service omits it, the read time is used. A budget in another unit than USD is a configuration bug.
import { DescribeBudgetCommand, type BudgetsClient } from "@aws-sdk/client-budgets";
import { fromAws, RunnerError } from "@dozebox/core/errors";
import type { Spend } from "../../ports/spend.ts";

export type AwsSpendDeps = {
  /** Budgets is a global service; its endpoint is in us-east-1. */
  readonly budgets: BudgetsClient;
  readonly accountId: string;
  readonly budgetName: string;
  /** Default Date.now. */
  readonly now?: () => number;
};

export function makeAwsSpend(deps: AwsSpendDeps): Spend {
  return {
    monthToDate: async () => {
      let out;
      try {
        out = await deps.budgets.send(
          new DescribeBudgetCommand({ AccountId: deps.accountId, BudgetName: deps.budgetName }),
        );
      } catch (e) {
        throw fromAws(e);
      }
      const budget = out.Budget;
      const actual = budget?.CalculatedSpend?.ActualSpend;
      if (actual?.Amount === undefined || actual.Amount === "") return null;
      if (actual.Unit !== undefined && actual.Unit !== "USD") {
        throw new RunnerError("internal", false, `budget ${deps.budgetName} is in ${actual.Unit}, not USD`);
      }
      const usd = Number(actual.Amount);
      if (!Number.isFinite(usd)) {
        throw new RunnerError("internal", false, `budget ${deps.budgetName}: spend "${actual.Amount}" is not a number`);
      }
      const asOf = budget?.LastUpdatedTime?.getTime() ?? (deps.now ?? Date.now)();
      return { usd, asOf };
    },
  };
}
