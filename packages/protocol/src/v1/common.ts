import { Type, type Static } from "typebox";

/** Caller-chosen id of a hold, wake or presence entry. Scoped to the payload. */
export const Id = Type.String({ pattern: "^[a-z0-9][a-z0-9._:-]{0,63}$" });
export type Id = Static<typeof Id>;

/** RFC 3339 UTC timestamp with millisecond precision and a trailing Z. */
export const Instant = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$",
});
export type Instant = Static<typeof Instant>;

/** Free text shown to people. Never parsed by the runner. */
export const Reason = Type.String({ minLength: 1, maxLength: 120 });
export type Reason = Static<typeof Reason>;

export const Severity = Type.Union([Type.Literal("page"), Type.Literal("notify"), Type.Literal("info")]);
export type Severity = Static<typeof Severity>;

export const ErrorCode = Type.Union([
  Type.Literal("bad_request"),
  Type.Literal("unknown_field"),
  Type.Literal("invalid_value"),
  Type.Literal("too_large"),
  Type.Literal("limit_exceeded"),
  Type.Literal("not_found"),
  Type.Literal("conflict"),
  Type.Literal("rate_limited"),
  Type.Literal("unsupported_version"),
  Type.Literal("shutting_down"),
  Type.Literal("internal"),
]);
export type ErrorCode = Static<typeof ErrorCode>;

export const ErrorBody = Type.Object(
  {
    error: Type.Object(
      {
        code: ErrorCode,
        message: Type.String({ maxLength: 500 }),
        field: Type.Optional(Type.String({ maxLength: 120 })),
        retryable: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ErrorBody = Static<typeof ErrorBody>;

/** HTTP status and retryability for each error code (part 4 §4.4). */
export const ERROR_STATUS: Readonly<Record<ErrorCode, { readonly status: number; readonly retryable: boolean }>> = {
  bad_request: { status: 400, retryable: false },
  unknown_field: { status: 400, retryable: false },
  invalid_value: { status: 400, retryable: false },
  too_large: { status: 413, retryable: false },
  limit_exceeded: { status: 409, retryable: false },
  not_found: { status: 404, retryable: false },
  conflict: { status: 409, retryable: false },
  rate_limited: { status: 429, retryable: true },
  unsupported_version: { status: 404, retryable: false },
  shutting_down: { status: 503, retryable: true },
  internal: { status: 500, retryable: true },
};

/** Request body limit for every endpoint, in bytes. */
export const REQUEST_BODY_LIMIT_BYTES = 16 * 1024;
