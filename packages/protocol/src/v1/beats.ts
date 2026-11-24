import { Type, type Static } from "typebox";
import { Instant } from "./common.ts";

export const BeatName = Type.String({ pattern: "^[a-z][a-z0-9._-]{0,40}$" });
export type BeatName = Static<typeof BeatName>;

export const Beat = Type.Object(
  {
    kind: Type.Union([Type.Literal("progress"), Type.Literal("loop")]),
    /** Payload-chosen label for progress or for a loop. */
    name: BeatName,
    /** When it happened. Default: when the agent received it. Not more than 5 min in the past or 5 s ahead. */
    at: Type.Optional(Instant),
    /**
     * Loop beats only: the payload's own deadline for this loop. If no beat with this name arrives for
     * this long, the agent counts the payload as unhealthy. Default: none (just recorded).
     */
    expectEverySeconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 7200 })),
  },
  { additionalProperties: false },
);
export type Beat = Static<typeof Beat>;

export const BeatsInput = Type.Object(
  { beats: Type.Array(Beat, { minItems: 1, maxItems: 32 }) },
  { additionalProperties: false },
);
export type BeatsInput = Static<typeof BeatsInput>;
