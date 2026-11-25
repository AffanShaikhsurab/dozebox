// The Budgets spend adapter on a stubbed SDK client: the spendPort contract offline, then the edge cases.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BudgetsClient } from "@aws-sdk/client-budgets";
import { rejectsWith, spendPortContract } from "@dozebox/testkit/contracts";
import { offlineConfig, stubHandlers, type HandlerStub } from "@dozebox/testkit/wire";
import { makeAwsSpend } from "../src/adapters/aws/budgets.ts";

const UPDATED = new Date("2026-11-25T03:00:00Z");

function setup(budget: () => unknown) {
  const budgets = new BudgetsClient(offlineConfig);
  const stub = stubHandlers(budgets);
  stub.on("DescribeBudgetCommand", () => ({ Budget: budget() }));
  const spend = makeAwsSpend({
    budgets,
    accountId: "000000000000",
    budgetName: "dozebox-box-1-monthly",
    now: () => 42,
  });
  return { stub, spend };
}

const withSpend = (amount: string, unit = "USD", updated: Date | null = UPDATED) => ({
  BudgetName: "dozebox-box-1-monthly",
  CalculatedSpend: { ActualSpend: { Amount: amount, Unit: unit } },
  ...(updated === null ? {} : { LastUpdatedTime: updated }),
});

const stubs = new WeakMap<object, HandlerStub>();
spendPortContract("aws budgets adapter (stubbed client)", async () => ({
  spendWith: async (usd) => {
    const { stub, spend } = setup(() => (usd === null ? { BudgetName: "b" } : withSpend(String(usd))));
    stubs.set(spend, stub);
    return spend;
  },
  inject: (spend, name, status) => stubs.get(spend)?.fail("DescribeBudgetCommand", name, status),
}));

test("reads the box's budget by account and name; asOf is LastUpdatedTime", async () => {
  const { stub, spend } = setup(() => withSpend("12.345"));
  assert.deepEqual(await spend.monthToDate(), { usd: 12.345, asOf: UPDATED.getTime() });
  assert.deepEqual(stub.inputs("DescribeBudgetCommand"), [
    { AccountId: "000000000000", BudgetName: "dozebox-box-1-monthly" },
  ]);
});

test("no CalculatedSpend, no ActualSpend or an empty amount -> null, not 0", async () => {
  for (const budget of [
    {},
    { CalculatedSpend: {} },
    { CalculatedSpend: { ActualSpend: { Amount: "", Unit: "USD" } } },
  ]) {
    assert.equal(await setup(() => budget).spend.monthToDate(), null);
  }
  assert.equal(await setup(() => undefined).spend.monthToDate(), null);
});

test("a real zero stays 0; a missing LastUpdatedTime uses the read time", async () => {
  assert.deepEqual(await setup(() => withSpend("0", "USD", null)).spend.monthToDate(), { usd: 0, asOf: 42 });
});

test("another unit or a non-number amount is internal; a missing budget is aws_not_found", async () => {
  await rejectsWith(setup(() => withSpend("1", "EUR")).spend.monthToDate(), "internal", false);
  await rejectsWith(setup(() => withSpend("lots")).spend.monthToDate(), "internal", false);
  const { stub, spend } = setup(() => withSpend("1"));
  stub.fail("DescribeBudgetCommand", "NotFoundException", 400);
  await rejectsWith(spend.monthToDate(), "aws_not_found", false);
});
