import { Type, type Static } from "typebox";
import { Id, Instant, Reason } from "./common.ts";

export const HoldKind = Type.Union([Type.Literal("work"), Type.Literal("wait")]);
export type HoldKind = Static<typeof HoldKind>;

export const HoldInput = Type.Object(
  {
    reason: Reason,
    /** When the hold ends unless renewed. Must be in the future. */
    until: Instant,
    /**
     * Upper bound on how long this hold may be renewed, counted from its first PUT.
     * Default: the payload's holdMaxSeconds. Renewing past it has no effect.
     */
    maxSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 86400 })),
    /** "work" holds count as activity for the idle verdict; "wait" holds keep the box awake but do not reset
     *  the no-progress clock. Default "work". */
    kind: Type.Optional(HoldKind),
  },
  { additionalProperties: false },
);
export type HoldInput = Static<typeof HoldInput>;

export const Hold = Type.Object({
  id: Id,
  reason: Reason,
  kind: HoldKind,
  /** First PUT of this id since it was last released or expired. */
  since: Instant,
  /** What the payload asked for. */
  requestedUntil: Instant,
  /** What the runner granted: min(requestedUntil, since + maxSeconds, box cap). */
  until: Instant,
  /** True when the grant is shorter than the request. */
  clamped: Type.Boolean(),
});
export type Hold = Static<typeof Hold>;

export const HoldList = Type.Object({ holds: Type.Array(Hold) });
export type HoldList = Static<typeof HoldList>;
