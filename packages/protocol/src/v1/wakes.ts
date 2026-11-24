import { Type, type Static } from "typebox";
import { Id, Instant, Reason } from "./common.ts";

/** GitHub event filter. Every given field must match; omitted fields match anything. */
export const GithubMatch = Type.Object(
  {
    source: Type.Literal("github"),
    /** "owner/name", case-insensitive. Required: a wake never matches every repository. */
    repository: Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }),
    /** X-GitHub-Event values, e.g. "check_suite", "pull_request_review". */
    events: Type.Array(Type.String({ pattern: "^[a-z_]{1,40}$" }), { minItems: 1, maxItems: 8 }),
    /** Pull request or issue number the event must be about. */
    number: Type.Optional(Type.Integer({ minimum: 1 })),
    /** Payload "action" values, e.g. "completed", "submitted". */
    actions: Type.Optional(Type.Array(Type.String({ pattern: "^[a-z_]{1,40}$" }), { maxItems: 8 })),
  },
  { additionalProperties: false },
);
export type GithubMatch = Static<typeof GithubMatch>;

/** Generic signed webhook: matches a POST to /v1/hooks/generic/{topic}. */
export const WebhookMatch = Type.Object(
  { source: Type.Literal("webhook"), topic: Type.String({ pattern: "^[a-z0-9-]{1,40}$" }) },
  { additionalProperties: false },
);
export type WebhookMatch = Static<typeof WebhookMatch>;

export const WakeMatch = Type.Union([GithubMatch, WebhookMatch]);
export type WakeMatch = Static<typeof WakeMatch>;

export const WakeInput = Type.Object(
  {
    reason: Reason,
    /** Wake at this time. */
    at: Type.Optional(Instant),
    /** Or wake when this event arrives. At least one of `at` and `on` is required. */
    on: Type.Optional(WakeMatch),
    /** Forget the request after this time. Default: `at` + 1 h for timed wakes, now + 7 days for event wakes. */
    expiresAt: Type.Optional(Instant),
  },
  { additionalProperties: false },
);
export type WakeInput = Static<typeof WakeInput>;

export const Wake = Type.Object({
  id: Id,
  reason: Reason,
  at: Type.Optional(Instant),
  on: Type.Optional(WakeMatch),
  expiresAt: Instant,
});
export type Wake = Static<typeof Wake>;

export const WakeList = Type.Object({ wakes: Type.Array(Wake) });
export type WakeList = Static<typeof WakeList>;
