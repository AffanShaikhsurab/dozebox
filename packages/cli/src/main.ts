// L1: the dispatcher. Global flags (`--box`, `--stack`, `--json`, `--dry-run`, `--yes`, `--verbose`), longest command
// name match (`snapshots list` before `snapshots`), box mode when `/run/dozebox/` exists.
import type { Command, CommandContext, ExitCode } from "./command.ts";

export const GLOBAL_OPTIONS = {
  box: { type: "string" },
  stack: { type: "string" },
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  yes: { type: "boolean" },
  verbose: { type: "boolean" },
} as const;

/** Golden-tested help text for the command list (or one command). */
export function helpText(_commands: ReadonlyArray<Command>, _name?: string): string {
  throw new Error("not implemented: L1 helpText");
}

export function dispatch(
  _commands: ReadonlyArray<Command>,
  _ctx: CommandContext,
  _mode: "operator" | "box",
): Promise<ExitCode> {
  throw new Error("not implemented: L1 dispatch");
}
