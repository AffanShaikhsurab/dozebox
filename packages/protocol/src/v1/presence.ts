import { Type, type Static } from "typebox";
import { Id, Instant } from "./common.ts";

export const PresenceKind = Type.Union([Type.Literal("interactive"), Type.Literal("viewing")]);
export type PresenceKind = Static<typeof PresenceKind>;

export const PresenceInput = Type.Object(
  {
    /** Until when the person counts as here. At most now + presenceMaxSeconds (15 min). Renew to extend. */
    until: Instant,
    /** "interactive": typing or clicking. "viewing": a visible window, no input. Only "interactive" resets idle. */
    kind: PresenceKind,
    /** Opaque label for logs, e.g. "web:tab-3". No personal data. */
    label: Type.Optional(Type.String({ maxLength: 60 })),
  },
  { additionalProperties: false },
);
export type PresenceInput = Static<typeof PresenceInput>;

export const Presence = Type.Object({
  id: Id,
  kind: PresenceKind,
  until: Instant,
});
export type Presence = Static<typeof Presence>;
