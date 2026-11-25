// The tick's work after its one action, all inside the reconcile lease (C4, C6): the outside judge, then the alert
// outbox drain. Every state write here is fenced by the lease token. Stores read their item and check its shape; a
// missing or unreadable item reads as the empty value.
import { emptyLedger, parseLedger, type Breaker } from "@dozebox/core/alerts";
import { Type } from "typebox";
import Value from "typebox/value";
import { makeOutbox } from "./alerts/outbox.ts";
import { checkBudgetFreeze } from "./caps/freeze.ts";
import { relativeParameter } from "./config.ts";
import { makeAlertRouter, type AlertRouter } from "./alerts/router.ts";
import { makeOutsideJudge, NO_MARKS, type JudgeMarks, type JudgeVerdict } from "./judge/outside.ts";
import type { AlertSink } from "./ports/alertSink.ts";
import type { Deps } from "./deps.ts";
import { KEYS, readBreaker, readKey } from "./state/keys.ts";

const BreakerSchema = Type.Object({
  state: Type.Union([Type.Literal("closed"), Type.Literal("open"), Type.Literal("half-open")]),
  failures: Type.Integer({ minimum: 0 }),
  openedAt: Type.Union([Type.Number(), Type.Null()]),
});
const Breakers = Type.Record(Type.String(), BreakerSchema);
const NullableMs = Type.Union([Type.Number(), Type.Null()]);
const Marks = Type.Object({ unresolvedWake: NullableMs, servedWake: NullableMs, silentServing: NullableMs });

/** Default no-progress park: 2 h without a progress beat, work hold or presence. */
const NO_PROGRESS_PARK_MS = 2 * 60 * 60_000;

export type AfterTickDeps = Pick<Deps, "config" | "state" | "clock" | "records" | "desired" | "log" | "spend"> & {
  readonly sinks: ReadonlyArray<AlertSink>;
  readonly rand?: () => number;
  readonly noProgressParkMs?: number;
};

export type AfterTick = {
  readonly alerts: AlertRouter;
  readonly run: (
    token: number,
    signal: AbortSignal,
  ) => Promise<{ readonly judge: JudgeVerdict; readonly sent: number }>;
};

export function makeAfterTick(deps: AfterTickDeps): AfterTick {
  const { state } = deps;
  const outbox = makeOutbox({ state, clock: deps.clock, rand: deps.rand ?? Math.random });
  const alerts = makeAlertRouter({
    sinks: deps.sinks,
    outbox,
    clock: deps.clock,
    breakers: {
      read: async (): Promise<Readonly<Record<string, Breaker>>> =>
        (await readKey(state, KEYS.alertBreakers, Breakers)) ?? {},
      write: (b, token) => state.putFenced(KEYS.alertBreakers, b, token),
    },
    ledger: {
      read: async () => {
        const raw = await state.get(KEYS.alertLedger);
        return raw === null ? emptyLedger() : parseLedger(JSON.stringify(raw));
      },
      write: (l, token) => state.putFenced(KEYS.alertLedger, l, token),
    },
  });
  const judge = makeOutsideJudge({
    clock: deps.clock,
    records: deps.records,
    desired: deps.desired,
    breaker: { read: () => readBreaker(state), write: (b, token) => state.putFenced(KEYS.wakeBreaker, b, token) },
    marks: {
      read: async (): Promise<JudgeMarks> => {
        const raw = await state.get(KEYS.judgeMarks);
        return Value.Check(Marks, raw) ? raw : NO_MARKS;
      },
      write: (m, token) => state.putFenced(KEYS.judgeMarks, m, token),
    },
    alerts,
    noProgressParkMs: deps.noProgressParkMs ?? NO_PROGRESS_PARK_MS,
  });
  const freezeName = relativeParameter(deps.config, deps.config.kill.freezeParameter);
  const budgetFreeze = (token: number) =>
    checkBudgetFreeze(
      {
        spend: deps.spend,
        policy: { monthlyBudgetUsd: deps.config.caps.monthlyBudgetUsd },
        now: deps.clock.now,
        // Written once per freeze; unfreeze (the operator) deletes the record. The tick then parks (frozen).
        freeze: async (v, t) => {
          if ((await deps.records.get(freezeName)) !== null) return;
          const record = { v: 1, frozen: true, by: "budget", reason: `budget ${v.percent ?? "?"}%` };
          await deps.records.put(freezeName, JSON.stringify(record), { tier: "Standard" });
          const now = deps.clock.now();
          const body = `Spend reached ${v.percent ?? "?"}% of the monthly budget; the box is frozen until unfreeze.`;
          await alerts.submit(
            {
              id: `budget-freeze:${now}`,
              key: "budget-freeze",
              severity: "page",
              title: "Budget freeze",
              body,
              source: "runner:caps",
              at: now,
            },
            t,
          );
        },
      },
      token,
    );
  return {
    alerts,
    run: async (token, signal) => {
      const verdict = await judge.run(token);
      await budgetFreeze(token).catch((e: unknown) =>
        deps.log.log("warn", "budget check failed", { error: e instanceof Error ? e.name : "unknown" }),
      );
      const sent = await alerts.drain(signal, token);
      return { judge: verdict, sent };
    },
  };
}
