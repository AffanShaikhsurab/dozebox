import { Type, type Static } from "typebox";
import { Instant } from "./common.ts";
import { Hold } from "./holds.ts";
import { Wake } from "./wakes.ts";

export const PHASES = ["booting", "serving", "idle-pending", "reclaim-notice", "sleeping", "frozen"] as const;

export const Phase = Type.Union([
  Type.Literal("booting"),
  Type.Literal("serving"),
  Type.Literal("idle-pending"),
  Type.Literal("reclaim-notice"),
  Type.Literal("sleeping"),
  Type.Literal("frozen"),
]);
export type Phase = Static<typeof Phase>;

export const DiskLevel = Type.Union([Type.Literal("ok"), Type.Literal("low"), Type.Literal("critical")]);
export type DiskLevel = Static<typeof DiskLevel>;

export const Status = Type.Object({
  box: Type.Object({
    id: Type.String(),
    phase: Phase,
    since: Instant,
    instance: Type.Object({
      id: Type.String(),
      type: Type.String(),
      az: Type.String(),
      lifecycle: Type.Union([Type.Literal("spot"), Type.Literal("on-demand")]),
    }),
    bootedAt: Instant,
    /** Set in reclaim-notice: when AWS will stop the instance. */
    terminationAt: Type.Optional(Instant),
    /** Total memory, for payloads that size their own parallelism. */
    memoryBytes: Type.Integer(),
    cpus: Type.Integer(),
    /** Base URL of the control API, for payloads that hand it to their own clients. Not a secret. */
    controlUrl: Type.Union([Type.String(), Type.Null()]),
  }),
  jail: Type.Object({
    ready: Type.Boolean(),
    egress: Type.Union([Type.Literal("imds-only"), Type.Literal("allowlist"), Type.Literal("off")]),
    /** Parts not ready, e.g. ["apparmor", "nftables"]. Empty when ready. */
    missing: Type.Array(Type.String()),
  }),
  idle: Type.Object({
    /** Null while something keeps the box awake. */
    since: Type.Union([Instant, Type.Null()]),
    /** When the box will park if nothing changes. Null while held. */
    sleepAt: Type.Union([Instant, Type.Null()]),
    /** What keeps the box awake now, e.g. ["hold:<payload>/<id>", "presence:<payload>/<id>"]. */
    awakeBecause: Type.Array(Type.String()),
  }),
  disk: Type.Object({
    level: DiskLevel,
    freePct: Type.Number(),
    freeBytes: Type.Integer(),
    at: Instant,
  }),
  caps: Type.Object({
    awakeSecondsToday: Type.Integer(),
    awakeSecondsCap: Type.Union([Type.Integer(), Type.Null()]),
  }),
  holds: Type.Array(Hold),
  wakes: Type.Array(Wake),
});
export type Status = Static<typeof Status>;
