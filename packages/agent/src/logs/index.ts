// A7: journald -> CloudWatch Logs `/<prefix>/<box>/box` with redaction and a daily byte budget; over budget, lines
// are dropped and one runner alert says so.
import { redact } from "../alerts/redact.ts";
import type { Loop } from "../loops.ts";
import type { LogEvent, LogTransport } from "../ports/logs.ts";

export { makeJournalReader, type JournalRead } from "./journal.ts";

export const LOG_SHIP_MS = 10_000;
export const LOG_DAILY_BUDGET_BYTES = 50 * 1024 * 1024;
const BATCH = 500;
const EVENT_OVERHEAD_BYTES = 26;

export type ShipperState = { readonly day: string; readonly bytesToday: number; readonly cursor: string | null };

export function logShipLoop(deps: {
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
  const budget = deps.budgetBytes ?? LOG_DAILY_BUDGET_BYTES;
  const dayOf = (): string => new Date(deps.now()).toISOString().slice(0, 10);
  let state: ShipperState = { day: dayOf(), bytesToday: 0, cursor: null };
  let overOn: string | null = null;

  return {
    name: "logs",
    everyMs: LOG_SHIP_MS,
    immediate: false,
    tick: async () => {
      const day = dayOf();
      if (day !== state.day) state = { day, bytesToday: 0, cursor: state.cursor };
      const read = await deps.read(state.cursor, BATCH);
      let bytes = state.bytesToday;
      let over = overOn === day;
      const ship: LogEvent[] = [];
      for (const e of read.events) {
        const message = redact(e.message);
        const size = Buffer.byteLength(message, "utf8") + EVENT_OVERHEAD_BYTES;
        if (!over && bytes + size <= budget) {
          bytes += size;
          ship.push({ at: e.at, message });
        } else {
          over = true;
        }
      }
      if (ship.length > 0) await deps.transport.send(deps.group, deps.stream, ship);
      state = { day, bytesToday: bytes, cursor: read.cursor };
      if (over && overOn !== day) {
        overOn = day;
        deps.onBudget(state);
      }
    },
  };
}
