// A7: journald -> CloudWatch Logs `/<prefix>/<box>/box` with redaction and a daily byte budget; over budget, lines
// are dropped and one runner alert says so.
import type { Loop } from "../loops.ts";
import type { LogEvent, LogTransport } from "../ports/logs.ts";

export const LOG_SHIP_MS = 10_000;
export const LOG_DAILY_BUDGET_BYTES = 50 * 1024 * 1024;

export type ShipperState = { readonly day: string; readonly bytesToday: number; readonly cursor: string | null };

export function logShipLoop(_deps: {
  readonly transport: LogTransport;
  readonly group: string;
  readonly stream: string;
  /** Journal lines after `cursor`, oldest first, at most `max`. */
  readonly read: (
    cursor: string | null,
    max: number,
  ) => Promise<{
    readonly events: ReadonlyArray<LogEvent>;
    readonly cursor: string | null;
  }>;
  readonly now: () => number;
  readonly budgetBytes?: number;
  readonly onBudget: (s: ShipperState) => void;
}): Loop {
  throw new Error("not implemented: A7 logShipLoop");
}
