// Records the box writes to SSM under /<prefix>/<boxId>/ (part 4 Â§4.14). Each holds one JSON document with `v`
// (record version) and `writer`. A reader that sees a higher `v` than it knows treats the record as missing.
import { Type, type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import { Instant } from "../v1/common.ts";

export const WriterTag = Type.Object({
  instanceId: Type.String({ pattern: "^i-[0-9a-f]{8,17}$" }),
  bootId: Type.String({ minLength: 8, maxLength: 64 }),
});
export type WriterTag = Static<typeof WriterTag>;

const recordBase = { v: Type.Literal(1), at: Instant, writer: WriterTag };

/** Record parameter names, relative to /<prefix>/<boxId>/. */
export const RECORD_NAMES = {
  liveness: "rec/liveness",
  wakes: "rec/wakes",
  serving: "rec/serving",
  lastWords: "rec/last-words",
  lastError: "rec/last-error",
  bootTimeline: "rec/boot-timeline",
  release: "rec/release",
  sleepFence: "fence/sleep-requested",
  wakeIntent: "ctl/wake-intent",
  config: "config",
} as const;

/** SSM size limits: standard parameters hold 4 KiB, advanced 8 KiB. */
export const RECORD_LIMIT_BYTES = { Standard: 4096, Advanced: 8192 } as const;

export const PayloadLiveness = Type.Object({
  name: Type.String(),
  health: Type.Union([Type.Literal("ok"), Type.Literal("failing"), Type.Literal("starting"), Type.Literal("unknown")]),
  healthDetail: Type.Optional(Type.String({ maxLength: 200 })),
  restartsThisHour: Type.Integer(),
  lastProgressAt: Type.Union([Instant, Type.Null()]),
  /** Newest progress beat per name, at most 8 names (the newest 8). */
  progress: Type.Record(Type.String(), Instant),
  holds: Type.Object({
    work: Type.Integer(),
    wait: Type.Integer(),
    until: Type.Union([Instant, Type.Null()]),
    /** Up to 5 reasons, newest first. */
    reasons: Type.Array(Type.String()),
  }),
});
export type PayloadLiveness = Static<typeof PayloadLiveness>;

export const LivenessRecord = Type.Object({
  ...recordBase,
  agent: Type.Object({ version: Type.String(), ok: Type.Boolean(), strikes: Type.Integer() }),
  payloads: Type.Array(PayloadLiveness, { maxItems: 4 }),
  presence: Type.Object({
    interactiveUntil: Type.Union([Instant, Type.Null()]),
    lastInteractiveAt: Type.Union([Instant, Type.Null()]),
  }),
  idle: Type.Object({ since: Type.Union([Instant, Type.Null()]), sleepAt: Type.Union([Instant, Type.Null()]) }),
  net: Type.Object({ ok: Type.Boolean(), downSince: Type.Union([Instant, Type.Null()]) }),
  disk: Type.Object({ level: Type.String(), freePct: Type.Number() }),
  /** Attention the agent could not hand to SNS; the control function sends these. */
  undelivered: Type.Array(
    Type.Object({ key: Type.String(), severity: Type.String(), title: Type.String(), at: Instant }),
    { maxItems: 5 },
  ),
  truncated: Type.Optional(Type.Boolean()),
});
export type LivenessRecord = Static<typeof LivenessRecord>;

export const WakesRecord = Type.Object({
  ...recordBase,
  /** Set by the last write before a park; the control function trusts the set only when this is true or the
   *  box is still serving. */
  atPark: Type.Boolean(),
  wakes: Type.Array(
    Type.Object({
      payload: Type.String(),
      id: Type.String(),
      reason: Type.String(),
      at: Type.Optional(Instant),
      on: Type.Optional(Type.Unknown()),
      expiresAt: Instant,
    }),
    { maxItems: 20 },
  ),
  truncated: Type.Optional(Type.Boolean()),
});
export type WakesRecord = Static<typeof WakesRecord>;

export const ParkReason = Type.Union([
  Type.Literal("idle"),
  Type.Literal("user"),
  Type.Literal("unhealthy"),
  Type.Literal("no-progress"),
  Type.Literal("cap"),
  Type.Literal("reclaim"),
  Type.Literal("failsafe"),
  Type.Literal("frozen"),
]);
export type ParkReason = Static<typeof ParkReason>;

export const LastWordsRecord = Type.Object({
  ...recordBase,
  parkedBecause: ParkReason,
  by: Type.Union([Type.Literal("agent"), Type.Literal("failsafe"), Type.Literal("control")]),
  detail: Type.String({ maxLength: 300 }),
  /** Up to 3, 300 characters each. */
  recentErrors: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 3 }),
  strikes: Type.Integer(),
  /** What held the box at the moment of the park. */
  awakeBecause: Type.Array(Type.String(), { maxItems: 10 }),
});
export type LastWordsRecord = Static<typeof LastWordsRecord>;

export const BootTimelineRecord = Type.Object({
  ...recordBase,
  upSeconds: Type.Number(),
  ok: Type.Boolean(),
  steps: Type.Array(
    Type.Object({
      step: Type.String({ pattern: "^[a-z][a-z0-9:-]{0,40}$" }),
      ms: Type.Integer(),
      upStart: Type.Number(),
      upEnd: Type.Number(),
    }),
    { maxItems: 24 },
  ),
});
export type BootTimelineRecord = Static<typeof BootTimelineRecord>;

export const LastErrorRecord = Type.Object({
  ...recordBase,
  source: Type.String({ pattern: "^[a-z][a-z0-9:-]{0,40}$" }),
  message: Type.String({ maxLength: 1000 }),
});
export type LastErrorRecord = Static<typeof LastErrorRecord>;

export const ServingRecord = Type.Object({ ...recordBase, payload: Type.String() });
export type ServingRecord = Static<typeof ServingRecord>;

export const SleepFence = Type.Object({
  ...recordBase,
  reason: ParkReason,
  phase: Type.Union([Type.Literal("before-stop"), Type.Literal("after-stop")]),
});
export type SleepFence = Static<typeof SleepFence>;


/** True when `value` matches `schema`. Lets readers check records without their own TypeBox dependency. */
export function matchesSchema(schema: TSchema, value: unknown): boolean {
  return Value.Check(schema, value);
}
