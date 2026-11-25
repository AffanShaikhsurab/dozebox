// L1: the dispatcher. Global flags (`--box`, `--stack`, `--json`, `--dry-run`, `--yes`, `--verbose`), longest command
// name match (`snapshots list` before `snapshots`), box mode when `/run/dozebox/` exists.
import { parseArgs, type ParseArgsConfig } from "node:util";
import { DozeboxCliError, EXIT, exitCodeOf, type Command, type CommandContext, type ExitCode } from "./command.ts";
import { dryRunDeps } from "./dry-run.ts";

export const GLOBAL_OPTIONS = {
  box: { type: "string" },
  stack: { type: "string" },
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  yes: { type: "boolean" },
  verbose: { type: "boolean" },
} as const;

const GLOBAL_HELP: ReadonlyArray<readonly [string, string]> = [
  ["--box <id>", "Which box (default: the stack's box, else main)."],
  ["--stack <dir>", "Directory with stack.json and the Terraform root (default ./.dozebox)."],
  ["--json", "One JSON document on stdout; logs on stderr."],
  ["--dry-run", "Print every call that would change state, change nothing."],
  ["--yes", "Skip confirmation prompts (needed with --json for destructive commands)."],
  ["--verbose", "Debug logs on stderr."],
];

type Options = NonNullable<ParseArgsConfig["options"]>;

function optionLines(options: Options): ReadonlyArray<readonly [string, string]> {
  return Object.entries(options).map(([name, o]) => {
    const flag = o.type === "string" ? `--${name} <value>` : `--${name}`;
    return [o.short === undefined ? flag : `-${o.short}, ${flag}`, o.multiple === true ? "(repeatable)" : ""];
  });
}

function table(rows: ReadonlyArray<readonly [string, string]>): ReadonlyArray<string> {
  const width = Math.max(...rows.map(([a]) => a.length));
  return rows.map(([a, b]) => (b === "" ? `  ${a}` : `  ${a.padEnd(width)}  ${b}`));
}

/** Golden-tested help text for the command list (or one command). */
export function helpText(commands: ReadonlyArray<Command>, name?: string): string {
  if (name !== undefined) {
    const cmd = commands.find((c) => c.name === name);
    if (cmd === undefined) throw new DozeboxCliError("usage", `unknown command: ${name}`);
    const own = optionLines(cmd.options);
    return [
      `Usage: dozebox ${cmd.name} [options]`,
      "",
      cmd.summary,
      ...(own.length > 0 ? ["", "Options:", ...table(own)] : []),
      "",
      "Global options:",
      ...table(GLOBAL_HELP),
      "",
    ].join("\n");
  }
  return [
    "Usage: dozebox <command> [options]",
    "",
    "Commands:",
    ...table(commands.map((c) => [c.name, c.summary] as const)),
    "",
    "Global options:",
    ...table(GLOBAL_HELP),
    "",
    "Run `dozebox help <command>` for a command's options.",
    "",
  ].join("\n");
}

/** The command whose name is the longest prefix of argv's leading words, and the rest of argv. */
export function findCommand(
  commands: ReadonlyArray<Command>,
  argv: ReadonlyArray<string>,
): { readonly command: Command; readonly rest: ReadonlyArray<string> } | null {
  let best: Command | null = null;
  let bestWords = 0;
  for (const c of commands) {
    const words = c.name.split(" ");
    if (words.length > bestWords && words.every((w, i) => argv[i] === w)) {
      best = c;
      bestWords = words.length;
    }
  }
  return best === null ? null : { command: best, rest: argv.slice(bestWords) };
}

const inMode = (mode: "operator" | "box") => (c: Command) => c.mode === mode || c.mode === "both";

function parse(command: Command, rest: ReadonlyArray<string>) {
  try {
    return parseArgs({
      args: [...rest],
      options: { ...GLOBAL_OPTIONS, ...command.options, help: { type: "boolean", short: "h" } },
      strict: true,
      allowPositionals: true,
      allowNegative: true,
    });
  } catch (e) {
    throw new DozeboxCliError("usage", e instanceof Error ? e.message : String(e));
  }
}

async function runOne(
  visible: ReadonlyArray<Command>,
  ctx: CommandContext,
  mode: "operator" | "box",
  json: { value: boolean },
): Promise<ExitCode> {
  const argv = ctx.argv;
  const head = argv[0];
  if (head === undefined || head === "--help" || head === "-h") {
    (head === undefined ? ctx.stderr : ctx.stdout)(helpText(visible));
    return head === undefined ? EXIT.usage : EXIT.ok;
  }
  if (head === "help") {
    const name = argv.slice(1).join(" ");
    ctx.stdout(helpText(visible, name === "" ? undefined : name));
    return EXIT.ok;
  }
  const found = findCommand(visible, argv);
  if (found === null) {
    const group = visible.filter((c) => c.name.startsWith(`${head} `));
    if (group.length > 0) {
      ctx.stderr(helpText(group));
      throw new DozeboxCliError(
        "usage",
        `${head} needs one of: ${group.map((c) => c.name.slice(head.length + 1)).join(", ")}`,
      );
    }
    const where = mode === "box" ? " on a box" : "";
    throw new DozeboxCliError("usage", `unknown command${where}: ${argv.filter((a) => !a.startsWith("-")).join(" ")}`);
  }
  const { command } = found;
  const { values, positionals } = parse(command, found.rest);
  json.value = values["json"] === true;
  if (values["help"] === true) {
    ctx.stdout(helpText(visible, command.name));
    return EXIT.ok;
  }
  const dry = values["dry-run"] === true;
  if (dry && mode === "box" && command.mutates) {
    ctx.stderr(`dry-run: would run dozebox ${argv.join(" ")}`);
    return EXIT.ok;
  }
  const print = (line: string): void => (json.value ? ctx.stderr : ctx.stdout)(`dry-run: ${line}`);
  const runCtx: CommandContext = dry ? { ...ctx, deps: dryRunDeps(ctx.deps, print) } : ctx;
  const result = await command.run(runCtx, values, positionals);
  if (json.value && result.json !== undefined) ctx.stdout(JSON.stringify(result.json, null, 2));
  return result.exitCode;
}

export async function dispatch(
  commands: ReadonlyArray<Command>,
  ctx: CommandContext,
  mode: "operator" | "box",
): Promise<ExitCode> {
  const json = { value: false };
  try {
    return await runOne(commands.filter(inMode(mode)), ctx, mode, json);
  } catch (e) {
    const code = ctx.signal.aborted ? EXIT.interrupted : exitCodeOf(e);
    const message = e instanceof Error ? e.message : String(e);
    ctx.stderr(`dozebox: ${message}`);
    if (json.value) {
      const kind = e instanceof DozeboxCliError ? e.code : code === EXIT.aws ? "aws" : "problem";
      ctx.stdout(JSON.stringify({ error: { code: kind, exitCode: code, message } }, null, 2));
    }
    return code;
  }
}
