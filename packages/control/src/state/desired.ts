// The desired state and the wake ledger (part 6 §6.3, part 9 R2). Wake and park only write here; the reconcile tick
// reads it and acts. Writes are fenced by order, not by the tick's lease, so an HTTP request needs no lease: a write
// older than the stored desired state is refused by the table and reported as "older", which is what R2 asks (a
// wake older than the newest park is void).
import type { Desired } from "@dozebox/core/reconcile";
import { DAY } from "@dozebox/core/time";
import type { StateTable } from "../ports/state.ts";
import { DesiredSchema, desiredOrder, KEYS, putNewest, readKey, WakeLedger } from "./keys.ts";

/** Before the first wake or park: asleep since the epoch, so any wake is newer. */
export const INITIAL_DESIRED: Desired = { want: "asleep", since: 0, reason: "initial", origin: "operator" };

export type DesiredStore = {
  readonly read: () => Promise<Desired>;
  readonly write: (d: Desired) => Promise<"written" | "older">;
};

export function makeDesiredStore(state: StateTable): DesiredStore {
  return {
    read: async () => (await readKey(state, KEYS.desired, DesiredSchema)) ?? INITIAL_DESIRED,
    write: (d) => putNewest(state, KEYS.desired, d, desiredOrder(d)),
  };
}

export type WakeLedgerStore = {
  /** Accept times (ms) of the last 24 hours, oldest first. */
  readonly read: (now: number) => Promise<ReadonlyArray<number>>;
  readonly append: (at: number) => Promise<void>;
};

const recent = (list: ReadonlyArray<number>, now: number): number[] =>
  list.filter((t) => t <= now && now - t < DAY).toSorted((a, b) => a - b);

/**
 * The wake budget's ledger. Read, append and write back, fenced by the newest time: two accepts in the same moment
 * can lose one entry, which only lets one extra wake through the budget (the budget is a rate limit, not a cap).
 */
export function makeWakeLedger(state: StateTable): WakeLedgerStore {
  const read = async (now: number) => recent((await readKey(state, KEYS.wakeLedger, WakeLedger))?.acceptedAt ?? [], now);
  return {
    read,
    append: async (at) => {
      const acceptedAt = [...(await read(at)), at];
      await putNewest(state, KEYS.wakeLedger, { acceptedAt }, at);
    },
  };
}
