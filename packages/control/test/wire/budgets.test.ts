// Wire: the Budgets spend adapter against the emulator (`pnpm test:wire`; skips when the emulator is not running).
// Each case creates its own budget; actual spend is seeded through CreateBudget's CalculatedSpend.
import { BudgetsClient, CreateBudgetCommand } from "@aws-sdk/client-budgets";
import { fresh, spendPortContract } from "@dozebox/testkit/contracts";
import { faultInjector, resolveWire } from "@dozebox/testkit/wire";
import { makeAwsSpend } from "../../src/adapters/aws/budgets.ts";
import type { Spend } from "../../src/ports/spend.ts";

const target = await resolveWire();
const ACCOUNT = "000000000000";

spendPortContract(
  "aws budgets adapter on the emulator",
  async () => {
    const injectors = new WeakMap<Spend, ReturnType<typeof faultInjector>>();
    return {
      spendWith: async (usd) => {
        const budgets = new BudgetsClient(target.config);
        const budgetName = fresh("dozebox-box-monthly");
        await budgets.send(
          new CreateBudgetCommand({
            AccountId: ACCOUNT,
            Budget: {
              BudgetName: budgetName,
              BudgetType: "COST",
              TimeUnit: "MONTHLY",
              BudgetLimit: { Amount: "25", Unit: "USD" },
              ...(usd === null ? {} : { CalculatedSpend: { ActualSpend: { Amount: String(usd), Unit: "USD" } } }),
            },
          }),
        );
        const spend = makeAwsSpend({ budgets, accountId: ACCOUNT, budgetName });
        injectors.set(spend, faultInjector(budgets));
        return spend;
      },
      // Throttling and denial cannot be provoked on the emulator on demand: injected in the client (unit-only rows).
      inject: (spend, name, status) => injectors.get(spend)?.("DescribeBudgetCommand", name, status),
    };
  },
  { skip: target.skip },
);
