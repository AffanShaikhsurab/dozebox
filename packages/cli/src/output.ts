// Output rules every command shares: with `--json` stdout carries one JSON document (the dispatcher prints the
// command's `json`), so human lines are dropped; without it, human lines go to stdout. Logs go to stderr.
import { DozeboxCliError, type CommandContext } from "./command.ts";

export type Values = Readonly<Record<string, unknown>>;

export const isJson = (values: Values): boolean => values["json"] === true;
export const isDryRun = (values: Values): boolean => values["dry-run"] === true;

/** A human line on stdout, unless `--json`. */
export function say(ctx: CommandContext, values: Values, line: string): void {
  if (!isJson(values)) ctx.stdout(line);
}

/**
 * Confirms a destructive step: `--yes` answers yes; `--json` without `--yes` is a usage error (nobody can answer);
 * `--dry-run` needs no answer (nothing changes). A "no" throws `refused` naming the step.
 */
export async function confirmDestructive(ctx: CommandContext, values: Values, question: string): Promise<void> {
  if (values["yes"] === true || isDryRun(values)) return;
  if (isJson(values)) throw new DozeboxCliError("usage", `--json needs --yes for this command (${question})`);
  if (!(await ctx.deps.prompt.confirm(question))) throw new DozeboxCliError("refused", "Cancelled; nothing changed.");
}

export function stringOpt(values: Values, name: string): string | undefined {
  const v = values[name];
  return typeof v === "string" ? v : undefined;
}

/** A positive integer option, or the default; anything else is a usage error. */
export function intOpt(values: Values, name: string, fallback: number): number {
  const v = stringOpt(values, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new DozeboxCliError("usage", `--${name} must be a positive whole number`);
  return n;
}

/** Exactly `n` positionals, named in the error. */
export function positionals(given: ReadonlyArray<string>, names: ReadonlyArray<string>): ReadonlyArray<string> {
  if (given.length < names.length) throw new DozeboxCliError("usage", `missing <${names[given.length]}>`);
  if (given.length > names.length) throw new DozeboxCliError("usage", `unexpected argument: ${given[names.length]}`);
  return given;
}
