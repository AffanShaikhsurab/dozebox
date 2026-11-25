// The control function's own items in the state table (`kv#<key>`, terraform/state.tf), with their shapes. A value
// that does not match its schema reads as absent (a newer writer, or a bug), never as a guess.
//
//   desired           Desired           fenced by `desiredOrder` (newest since wins, a park wins its own ms; R2)
//   wake-ledger       WakeLedger        fenced by the newest accept time; accept times of the last 24 h
//   wake-breaker      WakeBreaker       written by the outside judge (C6); read by /v1/wake
//   interruption      Interruption      fenced by its time; written by the EC2 event route (R1), read by the tick
//   last-start-error  LastStartError    written by the tick's act step (C3)
//   caps              CapsView          written by the tick (C3): awake and On-Demand minutes, month spend
//   awake-log         AwakeLog          written by the tick (C3): running intervals of the last 24 h
//   alerts-test       {at}              idempotency-style entry with a 60 s TTL: one test alert a minute
import { RunnerError } from "@dozebox/core/errors";
import type { Desired } from "@dozebox/core/reconcile";
import type { WakeBreaker } from "@dozebox/core/wake";
import { Type, type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import type { StateTable } from "../ports/state.ts";

const Ms = Type.Number({ minimum: 0 });

export const DesiredSchema = Type.Object({
  want: Type.Union([Type.Literal("awake"), Type.Literal("asleep")]),
  since: Ms,
  reason: Type.String(),
  origin: Type.Union([
    Type.Literal("user"),
    Type.Literal("auto"),
    Type.Literal("schedule"),
    Type.Literal("event"),
    Type.Literal("operator"),
    Type.Literal("judge"),
  ]),
});

export const WakeLedger = Type.Object({ acceptedAt: Type.Array(Ms) });
export type WakeLedger = Static<typeof WakeLedger>;

const WakeBreakerSchema = Type.Object({
  failuresInRow: Type.Integer({ minimum: 0 }),
  openedAt: Type.Union([Ms, Type.Null()]),
  threshold: Type.Integer({ minimum: 1 }),
  coolMs: Ms,
});

export const Interruption = Type.Object({ instanceId: Type.String({ minLength: 1 }), at: Ms });
export type Interruption = Static<typeof Interruption>;

export const LastStartError = Type.Object({
  at: Ms,
  kind: Type.Union([Type.Literal("capacity"), Type.Literal("refused"), Type.Literal("other")]),
});
export type LastStartError = Static<typeof LastStartError>;

export const CapsView = Type.Object({
  at: Ms,
  awakeMinutes: Type.Number({ minimum: 0 }),
  onDemandMinutes: Type.Number({ minimum: 0 }),
  monthSpendUsd: Type.Union([Type.Number(), Type.Null()]),
  /** The cap verdict of the tick that wrote it (the wake-again hysteresis reads 
ule and locksWake). */
  rule: Type.Optional(Type.String()),
  blocksWake: Type.Optional(Type.Boolean()),
  noOnDemand: Type.Optional(Type.Boolean()),
});
export type CapsView = Static<typeof CapsView>;

export const KEYS = {
  desired: "desired",
  wakeLedger: "wake-ledger",
  wakeBreaker: "wake-breaker",
  interruption: "interruption",
  lastStartError: "last-start-error",
  caps: "caps",
  awakeLog: "awake-log",
  alertsTest: "alerts-test",
} as const;

/** Read `key` and check it against `schema`; a missing or mismatched value is null. */
export async function readKey<S extends TSchema>(state: StateTable, key: string, schema: S): Promise<Static<S> | null> {
  const value = await state.get(key);
  return value !== null && Value.Check(schema, value) ? (value as Static<S>) : null;
}

/** A fenced write that is refused because a newer value is stored: "older", not an error. */
export async function putNewest(
  state: StateTable,
  key: string,
  value: unknown,
  order: number,
): Promise<"written" | "older"> {
  try {
    await state.putFenced(key, value, order);
    return "written";
  } catch (e) {
    if (e instanceof RunnerError && e.code === "lease_lost") return "older";
    throw e;
  }
}

/** The fence of a desired state: newer `since` wins, and in the same millisecond a park wins (R2, `newestDesired`). */
export const desiredOrder = (d: Desired): number => d.since * 2 + (d.want === "asleep" ? 1 : 0);

export const readBreaker = (state: StateTable): Promise<WakeBreaker | null> =>
  readKey(state, KEYS.wakeBreaker, WakeBreakerSchema);
