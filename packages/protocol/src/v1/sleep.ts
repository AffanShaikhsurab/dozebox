import { Type, type Static } from "typebox";
import { Instant } from "./common.ts";

export const SleepInput = Type.Object(
  {
    reason: Type.Union([Type.Literal("user")]),
    /** Ignore other payloads' holds. Never ignores a frozen box or a hand-off. */
    force: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type SleepInput = Static<typeof SleepInput>;

export const SleepAccepted = Type.Object({ parkingAt: Instant });
export type SleepAccepted = Static<typeof SleepAccepted>;

export const SleepRefused = Type.Object({
  error: Type.Object({ code: Type.Literal("conflict"), message: Type.String(), retryable: Type.Literal(false) }),
  /** What blocks the sleep, e.g. ["hold:<payload>/<id>"]. */
  blockers: Type.Array(Type.String()),
});
export type SleepRefused = Static<typeof SleepRefused>;
