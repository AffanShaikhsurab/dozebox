// D1: the drill framework types (part 13 D1). A drill is steps with deadlines and a teardown that always runs.
import type { CliDeps } from "../command.ts";
import type { StackContext } from "../stack.ts";

export type DrillContext = {
  readonly runId: string;
  readonly stackDir: string;
  readonly nonce: string;
  readonly log: (line: string) => void;
  readonly stack: StackContext;
  readonly deps: CliDeps;
};

export type DrillStep = {
  readonly id: string;
  readonly deadlineMs: number;
  readonly run: (ctx: DrillContext, signal: AbortSignal) => Promise<void>;
};

export type Drill = {
  readonly name: string;
  readonly estimateUsd: (ctx: DrillContext) => Promise<number>;
  readonly steps: ReadonlyArray<DrillStep>;
  readonly teardown: (ctx: DrillContext) => Promise<void>;
};
