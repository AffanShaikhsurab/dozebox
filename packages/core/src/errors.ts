// The one error type at the edges, and the one place AWS error names turn into it (part 6 §6.7, part 10 §10.4).
// Expected outcomes are values, not errors; bugs throw plain Error. Retry rules read `retryable` and nothing else.

export type RunnerErrorCode =
  | "aws_capacity"
  | "aws_conflict"
  | "aws_throttled"
  | "aws_denied"
  | "aws_limit"
  | "aws_unavailable"
  | "aws_not_found"
  | "lease_lost"
  | "invalid_input"
  | "internal";

export class RunnerError extends Error {
  readonly code: RunnerErrorCode;
  readonly retryable: boolean;
  constructor(code: RunnerErrorCode, retryable: boolean, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RunnerError";
    this.code = code;
    this.retryable = retryable;
  }
}

type AwsLike = {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
  readonly $metadata?: { readonly httpStatusCode?: unknown };
};

type Row = readonly [RunnerErrorCode, boolean];

/** Exact AWS error names (SDK v3 `name`, which is the service's error code). */
const TABLE: Readonly<Record<string, Row>> = {
  // Capacity: EC2 has none of this type in this AZ right now. Retried by the reconciler, not by the call helper.
  InsufficientInstanceCapacity: ["aws_capacity", true],
  InsufficientHostCapacity: ["aws_capacity", true],
  InsufficientCapacity: ["aws_capacity", true],
  SpotMaxPriceTooLow: ["aws_capacity", true],
  // Conflict: the resource is mid-transition (a Spot request still marked-for-stop, an instance still stopping).
  IncorrectSpotRequestState: ["aws_conflict", true],
  IncorrectInstanceState: ["aws_conflict", true],
  IncorrectState: ["aws_conflict", true],
  VolumeInUse: ["aws_conflict", true],
  ResourceContention: ["aws_conflict", true],
  ScalingActivityInProgress: ["aws_conflict", true],
  TransactionConflictException: ["aws_conflict", true],
  // Throttling, under every name the services in use give it.
  ThrottlingException: ["aws_throttled", true],
  Throttling: ["aws_throttled", true],
  ThrottledException: ["aws_throttled", true],
  RequestLimitExceeded: ["aws_throttled", true],
  TooManyUpdates: ["aws_throttled", true],
  ProvisionedThroughputExceededException: ["aws_throttled", true],
  // Denied: IAM said no. Never retried.
  AccessDeniedException: ["aws_denied", false],
  AccessDenied: ["aws_denied", false],
  UnauthorizedOperation: ["aws_denied", false],
  AuthorizationError: ["aws_denied", false],
  AuthFailure: ["aws_denied", false],
  // A conditional write lost: another writer holds a newer lease token.
  ConditionalCheckFailedException: ["lease_lost", false],
  // Quotas and size limits.
  LimitExceeded: ["aws_limit", false],
  LimitExceededException: ["aws_limit", false],
  ParameterLimitExceeded: ["aws_limit", false],
  ParameterMaxVersionLimitExceeded: ["aws_limit", false],
  ServiceQuotaExceededException: ["aws_limit", false],
  InstanceLimitExceeded: ["aws_limit", false],
  MaxSpotInstanceCountExceeded: ["aws_limit", false],
  VolumeLimitExceeded: ["aws_limit", false],
  TooManyTagsException: ["aws_limit", false],
  // Not found (names that do not end in NotFound).
  ParameterNotFound: ["aws_not_found", false],
  ResourceNotFoundException: ["aws_not_found", false],
  NotFoundException: ["aws_not_found", false],
  // The request itself was wrong.
  ValidationException: ["invalid_input", false],
  ValidationError: ["invalid_input", false],
  InvalidParameterValue: ["invalid_input", false],
  InvalidParameterException: ["invalid_input", false],
  InvalidParameterCombination: ["invalid_input", false],
  InvalidInputException: ["invalid_input", false],
  ParameterValueTooLarge: ["invalid_input", false],
};

/** Transport failures before any HTTP status: Node socket codes and the SDK's timeout names. */
const NETWORK = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "TimeoutError",
  "RequestTimeout",
  "RequestTimeoutException",
  "NetworkingError",
]);

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Map anything an AWS SDK call threw to a RunnerError. A RunnerError passes through unchanged. */
export function fromAws(e: unknown): RunnerError {
  if (e instanceof RunnerError) return e;
  const err: AwsLike = typeof e === "object" && e !== null ? e : {};
  const name = text(err.name) ?? text(err.code) ?? "Unknown";
  const code = text(err.code);
  const detail = text(err.message);
  const message = detail && detail !== name ? `${name}: ${detail}` : name;
  const hit = TABLE[name];
  if (hit) return new RunnerError(hit[0], hit[1], message, { cause: e });
  if (name.endsWith("NotFound")) return new RunnerError("aws_not_found", false, message, { cause: e });
  if (name.endsWith(".Malformed")) return new RunnerError("invalid_input", false, message, { cause: e });
  if (NETWORK.has(name) || (code !== null && NETWORK.has(code))) {
    return new RunnerError("aws_unavailable", true, message, { cause: e });
  }
  const status = typeof err.$metadata?.httpStatusCode === "number" ? err.$metadata.httpStatusCode : 0;
  if (status === 429) return new RunnerError("aws_throttled", true, message, { cause: e });
  return status >= 500
    ? new RunnerError("aws_unavailable", true, message, { cause: e })
    : new RunnerError("internal", false, message, { cause: e });
}
