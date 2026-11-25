// L1 (AWS half) and L2 (full): the `doctor` checks. Each is pure over facts so the doctor table is one test table.
import type { DoctorFacts } from "../ports/aws.ts";
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
};

export type DoctorCheck = { readonly id: string; readonly run: (i: DoctorInput) => CheckResult };

export function doctorChecks(): ReadonlyArray<DoctorCheck> {
  throw new Error("not implemented: L1 doctorChecks");
}
