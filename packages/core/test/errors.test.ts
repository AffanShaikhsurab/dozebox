import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fromAws, RunnerError, type RunnerErrorCode } from "../src/errors.ts";

type Row = {
  readonly name: string;
  readonly error: unknown;
  readonly expect: { readonly code: RunnerErrorCode; readonly retryable: boolean };
};

const aws = (name: string, status: number, message?: string) => ({
  name,
  $metadata: { httpStatusCode: status },
  ...(message === undefined ? {} : { message }),
});

const rows: ReadonlyArray<Row> = [
  {
    name: "Spot capacity",
    error: aws("InsufficientInstanceCapacity", 500),
    expect: { code: "aws_capacity", retryable: true },
  },
  {
    name: "Spot price too low",
    error: aws("SpotMaxPriceTooLow", 400),
    expect: { code: "aws_capacity", retryable: true },
  },
  {
    name: "Spot request still stopping",
    error: aws("IncorrectSpotRequestState", 400),
    expect: { code: "aws_conflict", retryable: true },
  },
  {
    name: "instance state conflict",
    error: aws("IncorrectInstanceState", 400),
    expect: { code: "aws_conflict", retryable: true },
  },
  { name: "volume in use", error: aws("VolumeInUse", 400), expect: { code: "aws_conflict", retryable: true } },
  {
    name: "ASG pending update",
    error: aws("ResourceContention", 500),
    expect: { code: "aws_conflict", retryable: true },
  },
  {
    name: "ASG activity running",
    error: aws("ScalingActivityInProgress", 400),
    expect: { code: "aws_conflict", retryable: true },
  },
  { name: "SSM throttled", error: aws("ThrottlingException", 400), expect: { code: "aws_throttled", retryable: true } },
  { name: "ASG throttled", error: aws("Throttling", 400), expect: { code: "aws_throttled", retryable: true } },
  {
    name: "EC2 throttled",
    error: aws("RequestLimitExceeded", 503),
    expect: { code: "aws_throttled", retryable: true },
  },
  {
    name: "DynamoDB throughput",
    error: aws("ProvisionedThroughputExceededException", 400),
    expect: { code: "aws_throttled", retryable: true },
  },
  { name: "unknown 429", error: aws("SlowDown", 429), expect: { code: "aws_throttled", retryable: true } },
  { name: "IAM refused", error: aws("AccessDeniedException", 400), expect: { code: "aws_denied", retryable: false } },
  {
    name: "EC2 IAM refused",
    error: aws("UnauthorizedOperation", 403),
    expect: { code: "aws_denied", retryable: false },
  },
  { name: "SNS IAM refused", error: aws("AuthorizationError", 403), expect: { code: "aws_denied", retryable: false } },
  {
    name: "lease lost",
    error: aws("ConditionalCheckFailedException", 400),
    expect: { code: "lease_lost", retryable: false },
  },
  { name: "policy too large", error: aws("LimitExceeded", 409), expect: { code: "aws_limit", retryable: false } },
  {
    name: "SSM parameter quota",
    error: aws("ParameterLimitExceeded", 400),
    expect: { code: "aws_limit", retryable: false },
  },
  {
    name: "SSM parameter missing",
    error: aws("ParameterNotFound", 400),
    expect: { code: "aws_not_found", retryable: false },
  },
  {
    name: "EC2 instance missing",
    error: aws("InvalidInstanceID.NotFound", 400),
    expect: { code: "aws_not_found", retryable: false },
  },
  {
    name: "Budgets budget missing",
    error: aws("NotFoundException", 400),
    expect: { code: "aws_not_found", retryable: false },
  },
  {
    name: "EC2 malformed id",
    error: aws("InvalidInstanceID.Malformed", 400),
    expect: { code: "invalid_input", retryable: false },
  },
  { name: "ASG validation", error: aws("ValidationError", 400), expect: { code: "invalid_input", retryable: false } },
  {
    name: "volume in another zone",
    error: aws("InvalidVolume.ZoneMismatch", 400),
    expect: { code: "invalid_input", retryable: false },
  },
  {
    name: "client token reused",
    error: aws("IdempotentParameterMismatch", 400),
    expect: { code: "invalid_input", retryable: false },
  },
  {
    name: "socket reset (Node code)",
    error: { name: "Error", code: "ECONNRESET" },
    expect: { code: "aws_unavailable", retryable: true },
  },
  { name: "SDK timeout", error: { name: "TimeoutError" }, expect: { code: "aws_unavailable", retryable: true } },
  { name: "unknown 5xx", error: aws("SomethingNew", 503), expect: { code: "aws_unavailable", retryable: true } },
  { name: "unknown 4xx", error: aws("SomethingNew", 400), expect: { code: "internal", retryable: false } },
  {
    name: "code only, no name",
    error: { code: "ParameterNotFound" },
    expect: { code: "aws_not_found", retryable: false },
  },
  {
    name: "metadata without a status",
    error: { name: "SomethingNew", $metadata: {} },
    expect: { code: "internal", retryable: false },
  },
  { name: "a string", error: "boom", expect: { code: "internal", retryable: false } },
  { name: "null", error: null, expect: { code: "internal", retryable: false } },
  { name: "plain Error", error: new Error("bug"), expect: { code: "internal", retryable: false } },
];

for (const row of rows) {
  test(`fromAws: ${row.name}`, () => {
    const e = fromAws(row.error);
    assert.ok(e instanceof RunnerError);
    assert.deepEqual({ code: e.code, retryable: e.retryable }, row.expect);
    assert.equal(e.cause, row.error);
  });
}

test("fromAws keeps the AWS message after the name, and does not repeat a message equal to the name", () => {
  assert.equal(fromAws(aws("ThrottlingException", 400, "Rate exceeded")).message, "ThrottlingException: Rate exceeded");
  assert.equal(fromAws(aws("ThrottlingException", 400, "ThrottlingException")).message, "ThrottlingException");
  assert.equal(fromAws({}).message, "Unknown");
});

test("fromAws passes a RunnerError through unchanged", () => {
  const original = new RunnerError("lease_lost", false, "older token");
  assert.equal(fromAws(original), original);
});

test("RunnerError carries code, retryable and cause", () => {
  const cause = new Error("x");
  const e = new RunnerError("aws_limit", false, "too big", { cause });
  assert.deepEqual(
    [e.name, e.code, e.retryable, e.message, e.cause],
    ["RunnerError", "aws_limit", false, "too big", cause],
  );
});
