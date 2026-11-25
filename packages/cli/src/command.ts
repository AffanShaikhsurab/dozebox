// L1: the command shape (part 5 §5.1 "CLI module shape"). Every command is one file in `commands/` exporting one
// Command; `main.ts` finds it by name, parses with `parseArgs({ strict: true })`, maps DozeboxCliError to exit codes.
import type { ParseArgsConfig } from "node:util";
import type { DozeboxClient } from "@dozebox/client";
import type { Clock } from "@dozebox/core/time";
import type { AwsOps } from "./ports/aws.ts";
import type { ControlApi } from "./ports/control.ts";
import type { Prompt } from "./ports/prompt.ts";
import type { CliFiles, Terraform } from "./ports/terraform.ts";
import type { Tools } from "./ports/tools.ts";

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 75 | 130;

export const EXIT = {
  ok: 0,
  problem: 1,
  usage: 2,
  notSetUp: 3,
  aws: 4,
  refused: 5,
  tryLater: 75,
  interrupted: 130,
} as const satisfies Readonly<Record<string, ExitCode>>;

export type CliDeps = {
  readonly control: ControlApi;
  readonly terraform: Terraform;
  readonly aws: AwsOps;
  /** The box's agent socket client in box mode, else null. */
  readonly agentSocket: DozeboxClient | null;
  readonly clock: Clock;
  readonly fs: CliFiles;
  readonly prompt: Prompt;
  readonly tools: Tools;
  readonly ids: { readonly random: () => string };
};

export type CommandContext = {
  readonly argv: ReadonlyArray<string>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly deps: CliDeps;
};

export type CommandResult = { readonly exitCode: ExitCode; readonly json?: unknown };

export type Command = {
  /** `snapshots list`. */
  readonly name: string;
  readonly summary: string;
  readonly options: NonNullable<ParseArgsConfig["options"]>;
  readonly mode: "operator" | "box" | "both";
  /** True: honours --dry-run and asks to confirm. */
  readonly mutates: boolean;
  readonly run: (
    ctx: CommandContext,
    values: Readonly<Record<string, unknown>>,
    positionals: ReadonlyArray<string>,
  ) => Promise<CommandResult>;
};

export type CliErrorCode = "usage" | "not-set-up" | "aws" | "refused" | "try-later" | "problem";

export class DozeboxCliError extends Error {
  readonly code: CliErrorCode;
  constructor(code: CliErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DozeboxCliError";
    this.code = code;
  }
}

/** Pure: the exit code for a thrown error (DozeboxCliError by code, RunnerError `aws_*` -> 4, else 1). */
export function exitCodeOf(e: unknown): ExitCode {
  if (e instanceof DozeboxCliError) return CODE_EXIT[e.code];
  if (isAbort(e)) return EXIT.interrupted;
  // Duck-typed so the CLI does not import core's errors module (packages.md: cli uses core `summary` and `time`).
  if (e instanceof Error && e.name === "RunnerError") {
    const code = (e as Error & { readonly code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("aws_")) return EXIT.aws;
  }
  return EXIT.problem;
}

const CODE_EXIT: Readonly<Record<CliErrorCode, ExitCode>> = {
  usage: EXIT.usage,
  "not-set-up": EXIT.notSetUp,
  aws: EXIT.aws,
  refused: EXIT.refused,
  "try-later": EXIT.tryLater,
  problem: EXIT.problem,
};

function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "Interrupted");
}

/** A command whose `run` is not written yet (contracts step): `run` throws "not implemented: <pkg> <name>". */
export function stubCommand(
  pkg: string,
  head: Omit<Command, "run" | "options"> & { readonly options?: Command["options"] },
): Command {
  return {
    ...head,
    options: head.options ?? {},
    run: () => {
      throw new Error(`not implemented: ${pkg} ${head.name}`);
    },
  };
}
