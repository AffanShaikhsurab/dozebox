// What the account has spent this month, from the cloud's billing data (late by hours; a backstop, not a cap).

export interface Spend {
  /** Month-to-date spend in USD and when the cloud computed it, or null when it has no data yet (never 0). */
  readonly monthToDate: () => Promise<{ readonly usd: number; readonly asOf: number } | null>;
}
