// Control API v1 (part 5 §5.3): the response of /v1/status and /v1/wake.
import { Type, type Static } from "typebox";
import { decode, isRecord, withFallback } from "../decode.ts";
import { Instant } from "../v1/common.ts";

export const CONTROL_STATES = [
  "parked",
  "launching",
  "running",
  "waiting-capacity",
  "replacing",
  "stopped-error",
] as const;

export const ControlState = Type.Union([
  Type.Literal("parked"),
  Type.Literal("launching"),
  Type.Literal("running"),
  Type.Literal("waiting-capacity"),
  Type.Literal("replacing"),
  Type.Literal("stopped-error"),
]);
export type ControlState = Static<typeof ControlState>;

export const SUMMARY_LEVELS = ["ok", "info", "warn", "bad"] as const;

export const SummaryLevel = Type.Union([
  Type.Literal("ok"),
  Type.Literal("info"),
  Type.Literal("warn"),
  Type.Literal("bad"),
]);
export type SummaryLevel = Static<typeof SummaryLevel>;

export const ControlStatus = Type.Object({
  v: Type.Literal(1),
  box: Type.String(),
  desired: Type.Union([Type.Literal("awake"), Type.Literal("asleep")]),
  state: ControlState,
  since: Instant,
  frozen: Type.Boolean(),
  instance: Type.Optional(
    Type.Object({
      id: Type.String(),
      type: Type.String(),
      az: Type.String(),
      launchedAt: Instant,
      lifecycle: Type.Union([Type.Literal("spot"), Type.Literal("on-demand")]),
    }),
  ),
  machine: Type.Optional(Type.Union([Type.Literal("persistent"), Type.Literal("fallback")])),
  /** Null while running but not serving yet. */
  servingSince: Type.Optional(Type.Union([Instant, Type.Null()])),
  lastError: Type.Optional(Type.Object({ message: Type.String(), at: Instant, source: Type.String() })),
  lastWords: Type.Optional(Type.Object({ parkedBecause: Type.String(), detail: Type.String(), at: Instant })),
  bootTimeline: Type.Optional(
    Type.Object({
      upSeconds: Type.Number(),
      steps: Type.Array(Type.Object({ step: Type.String(), ms: Type.Integer() })),
    }),
  ),
  /** Generic liveness summary while running (from rec/liveness). */
  liveness: Type.Optional(
    Type.Object({
      at: Instant,
      payloads: Type.Array(
        Type.Object({
          name: Type.String(),
          health: Type.String(),
          lastProgressAt: Type.Union([Instant, Type.Null()]),
        }),
      ),
      idleSleepAt: Type.Union([Instant, Type.Null()]),
      awakeBecause: Type.Array(Type.String()),
    }),
  ),
  nextWake: Type.Optional(Type.Object({ at: Instant, reason: Type.String(), payload: Type.String() })),
  caps: Type.Object({
    awakeHoursToday: Type.Number(),
    awakeHoursCap: Type.Union([Type.Number(), Type.Null()]),
    onDemandHoursToday: Type.Number(),
    onDemandHoursCap: Type.Number(),
    monthSpendUsd: Type.Union([Type.Number(), Type.Null()]),
    monthBudgetUsd: Type.Number(),
  }),
  wakePath: Type.Optional(
    Type.Object({ path: Type.String(), reason: Type.Optional(Type.String()), message: Type.String() }),
  ),
  alertPath: Type.Object({ level: SummaryLevel, say: Type.Optional(Type.String()) }),
  restoreTest: Type.Optional(Type.Object({ result: Type.String(), at: Instant })),
  summary: Type.Object({
    level: SummaryLevel,
    headline: Type.String(),
    detail: Type.String(),
    next: Type.String(),
    actions: Type.Array(Type.String()),
  }),
});
export type ControlStatus = Static<typeof ControlStatus>;

/** What `/v1/wake` and `/v1/park` did: `already-awake` wrote nothing (the box was already wanted awake). */
export const ControlDecision = Type.Union([Type.Literal("accept"), Type.Literal("already-awake")]);
export type ControlDecision = Static<typeof ControlDecision>;

/** The `202` body of `POST /v1/wake` and `POST /v1/park`: the status after the request, and the decision. */
export const ControlAnswer = Type.Object({ ...ControlStatus.properties, decision: ControlDecision });
export type ControlAnswer = Static<typeof ControlAnswer>;

/** Error codes of the control API (part 5 §5.3). Readers treat an unknown code by its HTTP status. */
export const ControlErrorCode = Type.Union([
  Type.Literal("bad_request"),
  Type.Literal("unauthorized"),
  Type.Literal("not_found"),
  Type.Literal("method_not_allowed"),
  Type.Literal("too_large"),
  Type.Literal("frozen"),
  Type.Literal("wake_budget"),
  Type.Literal("wake_breaker"),
  Type.Literal("rate_limited"),
  Type.Literal("internal"),
]);
export type ControlErrorCode = Static<typeof ControlErrorCode>;

/** HTTP status and retryability of each control API error code. */
export const CONTROL_ERROR_STATUS: Readonly<
  Record<ControlErrorCode, { readonly status: number; readonly retryable: boolean }>
> = {
  bad_request: { status: 400, retryable: false },
  unauthorized: { status: 401, retryable: false },
  not_found: { status: 404, retryable: false },
  method_not_allowed: { status: 405, retryable: false },
  too_large: { status: 413, retryable: false },
  frozen: { status: 423, retryable: false },
  wake_budget: { status: 429, retryable: true },
  wake_breaker: { status: 429, retryable: true },
  rate_limited: { status: 429, retryable: true },
  internal: { status: 500, retryable: true },
};

/** Every control API error body. `retryAfterSeconds` equals the `Retry-After` header of a 429. */
export const ControlErrorBody = Type.Object({
  error: Type.Object({
    code: ControlErrorCode,
    message: Type.String({ maxLength: 500 }),
    retryable: Type.Boolean(),
    retryAfterSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
});
export type ControlErrorBody = Static<typeof ControlErrorBody>;

/** Unknown `state` reads as this (the box is up in a way this client does not know yet). */
export const CONTROL_STATE_FALLBACK: ControlState = "running";
/** Unknown summary or alert-path `level` reads as this. */
export const SUMMARY_LEVEL_FALLBACK: SummaryLevel = "info";

/** Decode a control API status body with the tolerant-reader fallbacks. Throws ProtocolDecodeError. */
export function normalizeControlStatus(raw: unknown): ControlStatus {
  let value = raw;
  if (isRecord(raw)) {
    let next = withFallback(raw, "state", CONTROL_STATES, CONTROL_STATE_FALLBACK);
    for (const key of ["summary", "alertPath"] as const) {
      const part = next[key];
      if (isRecord(part))
        next = { ...next, [key]: withFallback(part, "level", SUMMARY_LEVELS, SUMMARY_LEVEL_FALLBACK) };
    }
    value = next;
  }
  return decode<ControlStatus>(ControlStatus, "ControlStatus", value);
}
