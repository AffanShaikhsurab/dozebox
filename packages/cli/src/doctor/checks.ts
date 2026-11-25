// L1 (AWS half) and L2 (full): the `doctor` checks. Each is pure over facts so the doctor table is one test table.
import type { ControlStatus } from "@dozebox/protocol/control";
import { DAY, ageMs, parseInstant } from "@dozebox/core/time";
import type { DoctorFacts, EmailSubscription } from "../ports/aws.ts";
import type { StackContext } from "../stack.ts";

export type CheckResult = {
  readonly id: string;
  readonly level: "ok" | "warn" | "fail";
  readonly message: string;
  /** What `--fix` would do, when it can. */
  readonly fix?: string;
};

export type DoctorInput = {
  readonly tools: Readonly<Record<"aws" | "terraform" | "node", string | null>>;
  readonly facts: DoctorFacts;
  readonly stack: StackContext | null;
  readonly missingOutputs: ReadonlyArray<string>;
  /** L2 facts; null when the stack is missing or the fact could not be read. */
  readonly now: number;
  readonly status: ControlStatus | null;
  readonly statusError: string | null;
  readonly tokenPresent: boolean | null;
  readonly emailSubscriptions: ReadonlyArray<EmailSubscription> | null;
};

export type DoctorCheck = { readonly id: string; readonly run: (i: DoctorInput) => CheckResult };

/** IAM managed policy size limit (characters, whitespace excluded). */
const POLICY_LIMIT = 6144;
/** Lambda keeps at least this much concurrency unreserved; the control function reserves from the rest. */
const MIN_UNRESERVED = 10;
/** vCPUs the smallest supported instance type needs. */
const MIN_VCPUS = 4;
const RESTORE_TEST_MAX_AGE_MS = 8 * DAY;

const ok = (id: string, message: string): CheckResult => ({ id, level: "ok", message });
const warn = (id: string, message: string, fix?: string): CheckResult =>
  fix === undefined ? { id, level: "warn", message } : { id, level: "warn", message, fix };
const fail = (id: string, message: string, fix?: string): CheckResult =>
  fix === undefined ? { id, level: "fail", message } : { id, level: "fail", message, fix };

const NO_STACK = "skipped: no stack";

function tool(id: "aws" | "terraform" | "node", required: boolean): DoctorCheck {
  return {
    id: `tool-${id}`,
    run: (i) => {
      const v = i.tools[id];
      if (v !== null) return ok(`tool-${id}`, `${id} ${v}`);
      return required ? fail(`tool-${id}`, `${id} is not installed`) : warn(`tool-${id}`, `${id} is not installed`);
    },
  };
}

function quota(id: string, value: number | null, what: string): CheckResult {
  if (value === null) return warn(id, `cannot read the ${what} vCPU quota`);
  if (value < MIN_VCPUS) return warn(id, `${what} vCPU quota is ${value}; ask AWS for at least ${MIN_VCPUS}`);
  return ok(id, `${what} vCPU quota ${value}`);
}

const AWS_CHECKS: ReadonlyArray<DoctorCheck> = [
  tool("node", true),
  tool("terraform", true),
  tool("aws", false),
  {
    id: "credentials",
    run: (i) =>
      i.facts.account === null
        ? fail(
            "credentials",
            "no working AWS credentials (STS GetCallerIdentity failed); run aws sso login or aws configure",
          )
        : ok("credentials", `account ${i.facts.account}`),
  },
  {
    id: "region",
    run: (i) => {
      if (i.facts.region === null) return fail("region", "no AWS region; set AWS_REGION or the profile's region");
      if (i.stack !== null && i.stack.region !== i.facts.region) {
        return warn("region", `credentials default to ${i.facts.region} but the stack is in ${i.stack.region}`);
      }
      return ok("region", i.facts.region);
    },
  },
  {
    id: "cost-tag",
    run: (i) => {
      const prefix = i.stack?.tagPrefix ?? "dozebox";
      if (i.facts.costTagActive === null) return warn("cost-tag", `cannot read the ${prefix}:box cost allocation tag`);
      return i.facts.costTagActive
        ? ok("cost-tag", `${prefix}:box cost allocation tag active`)
        : warn("cost-tag", `${prefix}:box is not an active cost allocation tag`, "run dozebox bootstrap");
    },
  },
  {
    id: "lambda-concurrency",
    run: (i) => {
      const n = i.facts.unreservedConcurrency;
      if (n === null) return warn("lambda-concurrency", "cannot read the Lambda account concurrency");
      if (n < MIN_UNRESERVED) {
        return fail("lambda-concurrency", `only ${n} unreserved Lambda concurrency; ask AWS for a higher limit`);
      }
      return ok("lambda-concurrency", `${n} unreserved Lambda concurrency`);
    },
  },
  { id: "quota-spot", run: (i) => quota("quota-spot", i.facts.spotVcpuQuota, "Spot") },
  { id: "quota-on-demand", run: (i) => quota("quota-on-demand", i.facts.onDemandVcpuQuota, "On-Demand") },
  {
    id: "stack-outputs",
    run: (i) => {
      if (i.stack !== null) return ok("stack-outputs", `stack ${i.stack.stackDir}: box ${i.stack.boxId}`);
      if (i.missingOutputs.length > 0) {
        return fail("stack-outputs", `missing outputs: ${i.missingOutputs.join(", ")}`, "run dozebox setup");
      }
      return fail("stack-outputs", "no stack", "run dozebox setup");
    },
  },
];

function policySizes(i: DoctorInput): CheckResult {
  if (i.stack === null) return warn("policy-sizes", NO_STACK);
  const sizes = i.stack.policySizes;
  if (sizes === null) return warn("policy-sizes", "the stack has no iam_policy_sizes output");
  const over = Object.entries(sizes).filter(([, n]) => n > POLICY_LIMIT);
  if (over.length > 0) {
    return fail("policy-sizes", `over ${POLICY_LIMIT} characters: ${over.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  }
  const largest = Math.max(0, ...Object.values(sizes));
  return ok("policy-sizes", `largest IAM policy ${largest} of ${POLICY_LIMIT} characters`);
}

function restoreTest(i: DoctorInput): CheckResult {
  const t = i.status?.restoreTest;
  if (i.status === null) return warn("restore-test", NO_STACK);
  if (t === undefined) return warn("restore-test", "the weekly restore test has not run yet");
  if (t.result !== "ok" && t.result !== "passed") return fail("restore-test", `last restore test: ${t.result}`);
  const age = ageMs(i.now, parseInstant(t.at));
  if (age === null || age > RESTORE_TEST_MAX_AGE_MS) return warn("restore-test", `last restore test passed at ${t.at}`);
  return ok("restore-test", `restore test passed at ${t.at}`);
}

const STACK_CHECKS: ReadonlyArray<DoctorCheck> = [
  { id: "policy-sizes", run: policySizes },
  {
    id: "control",
    run: (i) => {
      if (i.stack === null) return warn("control", NO_STACK);
      if (i.status === null) return fail("control", `control API unreachable: ${i.statusError ?? "unknown error"}`);
      return ok("control", `${i.status.box}: ${i.status.state}`);
    },
  },
  {
    id: "token",
    run: (i) => {
      if (i.stack === null || i.tokenPresent === null) return warn("token", NO_STACK);
      return i.tokenPresent
        ? ok("token", `wake token stored in ${i.stack.wakeTokenParameter}`)
        : fail("token", `no wake token in ${i.stack.wakeTokenParameter}`, "store a new wake token");
    },
  },
  {
    id: "frozen",
    run: (i) =>
      i.status?.frozen === true
        ? fail("frozen", "the kill switch froze the box", "run dozebox unfreeze --reason <why> (not done by --fix)")
        : ok("frozen", "not frozen"),
  },
  {
    id: "alert-path",
    run: (i) => {
      if (i.status === null) return warn("alert-path", NO_STACK);
      const a = i.status.alertPath;
      const say = a.say === undefined ? "" : `: ${a.say}`;
      if (a.level === "bad") return fail("alert-path", `alerts cannot reach you${say}`);
      if (a.level === "warn") return warn("alert-path", `alert path degraded${say}`);
      return ok("alert-path", `alert path ${a.level}`);
    },
  },
  {
    id: "alert-email",
    run: (i) => {
      const subs = i.emailSubscriptions;
      if (subs === null) return warn("alert-email", NO_STACK);
      const pending = subs.filter((s) => s.pending);
      if (pending.length > 0) {
        return warn(
          "alert-email",
          `email not confirmed: ${pending.map((s) => s.endpoint).join(", ")}`,
          "send the confirmation email again",
        );
      }
      return subs.length === 0 ? ok("alert-email", "no email sink") : ok("alert-email", `${subs.length} email sink(s)`);
    },
  },
  {
    id: "front-door",
    run: (i) => {
      if (i.stack === null) return warn("front-door", NO_STACK);
      return i.stack.frontDoorDomain === null
        ? warn("front-door", "front door off: only SigV4 callers reach the control API (no phone, no wake page)")
        : ok("front-door", `front door ${i.stack.frontDoorDomain}`);
    },
  },
  { id: "restore-test", run: restoreTest },
];

export function doctorChecks(): ReadonlyArray<DoctorCheck> {
  return [...AWS_CHECKS, ...STACK_CHECKS];
}
