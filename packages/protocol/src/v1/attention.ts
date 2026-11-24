import { Type, type Static } from "typebox";
import { Severity } from "./common.ts";

export const AttentionInput = Type.Object(
  {
    /** Dedupe key. The same key within dedupeSeconds is accepted but not sent again. */
    key: Type.String({ pattern: "^[A-Za-z0-9._:@/-]{1,120}$" }),
    severity: Severity,
    title: Type.String({ minLength: 1, maxLength: 120 }),
    body: Type.String({ maxLength: 1000 }),
    /** A link the alert opens, https only. */
    url: Type.Optional(Type.String({ pattern: "^https://", maxLength: 500 })),
    /** Default 3600. */
    dedupeSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 86400 })),
  },
  { additionalProperties: false },
);
export type AttentionInput = Static<typeof AttentionInput>;

export const AttentionAccepted = Type.Object({
  alertId: Type.String(),
  /** True when the key was seen within dedupeSeconds and nothing new was sent. */
  deduped: Type.Boolean(),
});
export type AttentionAccepted = Static<typeof AttentionAccepted>;
