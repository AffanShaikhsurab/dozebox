// D1: the drill framework types (part 13 D1). A drill is steps with deadlines and a teardown that always runs.
import type { CliDeps, ExitCode } from "../command.ts";
import type { StackContext } from "../stack.ts";

/** What `dozebox drill <name>` was asked for, beyond the drill itself. */
export type DrillOptions = {
  /** `--with-hold`: smoke adds the hold step (phase 4). */
  readonly withHold: boolean;
  /** `--extra jail,tripwire,agent-rollback` (phase 6). */
  readonly extras: ReadonlyArray<string>;
  /** `--keep`: teardown parks the stack instead of destroying it (the warm stack between drills). */
  readonly keep: boolean;
  /**
   * `--deliver <tarball>`: an agent release tarball to push to the box through SSM when the box cannot download its
   * release (a private repository's assets need a token); null to rely on stage 0's download.
   */
  readonly deliver: string | null;
  /** `--broken <tarball>`: the deliberately broken release for `--extra agent-rollback`. */
  readonly broken: string | null;
};

/** One CLI command run by a drill step, with `--stack <dir> --json --yes`. */
export type CliRun = { readonly code: ExitCode; readonly json: unknown; readonly out: ReadonlyArray<string> };

export type DrillContext = {
  readonly runId: string;
  readonly stackDir: string;
  readonly nonce: string;
  readonly log: (line: string) => void;
  /** The stack's context, read fresh (a deploy step changes it). */
  readonly stack: () => Promise<StackContext>;
  readonly deps: CliDeps;
  readonly options: DrillOptions;
  /** `dozebox <argv> --stack <dir> --json --yes` through the dispatcher, with these deps. */
  readonly cli: (argv: ReadonlyArray<string>, signal: AbortSignal) => Promise<CliRun>;
  /** Facts a step found for later steps and the report (instance types and lifecycles seen, volume ids, ...). */
  readonly facts: Map<string, unknown>;
};

export type DrillStep = {
  readonly id: string;
  readonly deadlineMs: number;
  readonly run: (ctx: DrillContext, signal: AbortSignal) => Promise<void>;
  /** When false the step is left out (for example the hold step without `--with-hold`). */
  readonly when?: (options: DrillOptions) => boolean;
};

export type Drill = {
  readonly name: string;
  readonly estimateUsd: (ctx: DrillContext) => Promise<number>;
  readonly steps: ReadonlyArray<DrillStep>;
  readonly teardown: (ctx: DrillContext) => Promise<void>;
  /** Set when the drill cannot run in this account; the report records `blocked` and no step runs. */
  readonly blocked?: string;
};
