// Shared parts of FakeAws: ids, tag names, and one-shot faults that fail the next call the way AWS fails it.
import { fromAws, type RunnerError } from "@dozebox/core/errors";

export type Now = { readonly now: () => number };

export type FaultOp =
  | "ec2.describe"
  | "ec2.start"
  | "ec2.stop"
  | "asg.describe"
  | "asg.setDesired"
  | "ebs.describe"
  | "ebs.tag"
  | "ebs.create"
  | "ebs.attach"
  | "ssm.get"
  | "ssm.put"
  | "ssm.delete"
  | "dynamodb.write"
  | "dynamodb.get"
  | "budgets.describe"
  | "sns.publish"
  | "logs.put";

export type Faults = {
  /** The next call of `op` throws what the adapter would throw for AWS error `name` with HTTP `status`. */
  readonly failNext: (op: FaultOp, name: string, status?: number) => void;
  /** Throws when a fault is queued for `op` (used by the fakes, not by tests). */
  readonly check: (op: FaultOp) => void;
};

export function makeFaults(): Faults {
  const queued = new Map<FaultOp, RunnerError[]>();
  return {
    failNext: (op, name, status = 400) => {
      const list = queued.get(op) ?? [];
      list.push(fromAws({ name, message: `injected by FakeAws`, $metadata: { httpStatusCode: status } }));
      queued.set(op, list);
    },
    check: (op) => {
      const next = queued.get(op)?.shift();
      if (next) throw next;
    },
  };
}

export type Tags = { readonly box: string; readonly role: string; readonly active: string };

export const tagNames = (prefix: string): Tags => ({
  box: `${prefix}:box`,
  role: `${prefix}:role`,
  active: `${prefix}:active`,
});

/** Deterministic AWS-shaped ids: `i-` + 17 hex, `vol-` + 17 hex. */
export function makeIds(): (kind: "i" | "vol" | "snap" | "sir" | "msg") => string {
  let n = 0;
  return (kind) => `${kind}-${(++n).toString(16).padStart(17, "0")}`;
}

/** An AWS error for a call the fake refuses on its own (not an injected fault). */
export const awsError = (name: string, message: string, status = 400): RunnerError =>
  fromAws({ name, message, $metadata: { httpStatusCode: status } });

/** Let other promises run first, so "concurrent" calls in tests really interleave. */
export const turn = (): Promise<void> => new Promise<void>((resolve) => queueMicrotask(resolve));
