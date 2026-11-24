import { Type, type Static } from "typebox";
import { Id, Instant } from "./common.ts";
import { DiskLevel, Phase } from "./status.ts";

/** Server-sent event data, one schema per `event` name (part 4 §4.11). */
export const PhaseEvent = Type.Object({ phase: Phase, since: Instant });
export type PhaseEvent = Static<typeof PhaseEvent>;

export const ReclaimNoticeEvent = Type.Object({ terminationAt: Instant, stopGraceSeconds: Type.Integer() });
export type ReclaimNoticeEvent = Static<typeof ReclaimNoticeEvent>;

export const SleepingEvent = Type.Object({ reason: Type.String(), at: Instant });
export type SleepingEvent = Static<typeof SleepingEvent>;

export const DiskEvent = Type.Object({ level: DiskLevel, freePct: Type.Number() });
export type DiskEvent = Static<typeof DiskEvent>;

export const HoldClampedEvent = Type.Object({ id: Id, until: Instant });
export type HoldClampedEvent = Static<typeof HoldClampedEvent>;

export const CapReachedEvent = Type.Object({ cap: Type.String(), resetAt: Instant });
export type CapReachedEvent = Static<typeof CapReachedEvent>;

export const PingEvent = Type.Object({});
export type PingEvent = Static<typeof PingEvent>;

export const EVENT_SCHEMAS = {
  phase: PhaseEvent,
  "reclaim-notice": ReclaimNoticeEvent,
  sleeping: SleepingEvent,
  disk: DiskEvent,
  "hold-clamped": HoldClampedEvent,
  "cap-reached": CapReachedEvent,
  ping: PingEvent,
} as const;

export type EventName = keyof typeof EVENT_SCHEMAS;

/** Events older than the last EVENT_REPLAY_LIMIT are dropped; a client then re-reads /v1/status. */
export const EVENT_REPLAY_LIMIT = 100;
export const EVENT_PING_SECONDS = 25;
