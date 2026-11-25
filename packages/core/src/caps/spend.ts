// The spend freeze judgement from the cloud's billing data (part 13 WP-K4). Budgets data is late by hours and may be
// missing: no data means no freeze, and the awake and On-Demand caps are still enforced from EC2 state, which does not
// depend on billing data.

export type SpendReading = { readonly usd: number; readonly asOf: number } | null;

export type SpendPolicy = {
  readonly monthlyBudgetUsd: number;
  /** Freeze at or above this share of the monthly budget (default 100). */
  readonly freezeAtPercent?: number;
  /** Warn at or above this share (default 80). */
  readonly warnAtPercent?: number;
};

export type SpendVerdict =
  | { readonly level: "unknown"; readonly freeze: false; readonly percent: null }
  | { readonly level: "ok" | "warn"; readonly freeze: false; readonly percent: number; readonly asOf: number }
  | { readonly level: "freeze"; readonly freeze: true; readonly percent: number; readonly asOf: number };

export function judgeSpend(spend: SpendReading, policy: SpendPolicy): SpendVerdict {
  if (spend === null || !Number.isFinite(spend.usd) || !(policy.monthlyBudgetUsd > 0)) {
    return { level: "unknown", freeze: false, percent: null };
  }
  const percent = Math.round((spend.usd / policy.monthlyBudgetUsd) * 1000) / 10;
  if (percent >= (policy.freezeAtPercent ?? 100)) return { level: "freeze", freeze: true, percent, asOf: spend.asOf };
  const level = percent >= (policy.warnAtPercent ?? 80) ? "warn" : "ok";
  return { level, freeze: false, percent, asOf: spend.asOf };
}
