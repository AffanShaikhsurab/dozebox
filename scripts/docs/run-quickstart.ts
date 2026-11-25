// Runs every `dozebox ...` command of the ```bash blocks in docs/quickstart.md through the CLI's `dispatch`, against
// the testkit fakes instead of AWS, Terraform and the control function. A command the CLI does not know fails.
// Usage: node --conditions=@dozebox/source scripts/docs/run-quickstart.ts --dry-run
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../../packages/cli/src/commands/index.ts";
import { dispatch } from "../../packages/cli/src/main.ts";
import {
  controlStatusFixture,
  makeFakeCliDeps,
  makeFakePrompt,
  stackOutputsFixture,
} from "../../packages/testkit/src/fakes/fakes-cli.ts";

export type QuickstartResult = {
  readonly command: string;
  readonly exitCode: number;
  /** Null when the command ran and exited 0. */
  readonly problem: string | null;
};

/** `dozebox wake --wait` -> ["wake", "--wait"]. Single and double quotes group words; an unquoted `#` starts a comment. */
export function splitArgs(line: string): ReadonlyArray<string> {
  const out: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    if (quote !== null) {
      if (c === quote) quote = null;
      else word = (word ?? "") + c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word ??= "";
    } else if (/\s/.test(c)) {
      if (word !== null) out.push(word);
      word = null;
    } else if (c === "#" && word === null) break;
    else word = (word ?? "") + c;
  }
  if (word !== null) out.push(word);
  return out;
}

/** Every `dozebox ...` command in the ```bash blocks, with `\` continuations joined and the part after a pipe kept. */
export function extractCommands(markdown: string): ReadonlyArray<string> {
  const out: string[] = [];
  let lang: string | null = null;
  let pending = "";
  for (const raw of markdown.split(/\r?\n/)) {
    const fence = /^\s*```(\w*)/.exec(raw);
    if (fence !== null) {
      lang = lang === null ? (fence[1] ?? "") : null;
      pending = "";
      continue;
    }
    if (lang !== "bash") continue;
    const joined = `${pending}${raw.trim().replace(/^\$\s+/, "")}`;
    if (joined.endsWith("\\")) {
      pending = `${joined.slice(0, -1).trimEnd()} `;
      continue;
    }
    pending = "";
    const command =
      joined
        .split(/\s\|\s/)
        .at(-1)
        ?.trim() ?? "";
    if (/^dozebox(\s|$)/.test(command)) out.push(command);
  }
  return out;
}

function fakeDeps() {
  const deps = makeFakeCliDeps({
    status: controlStatusFixture(),
    outputs: stackOutputsFixture(),
    prompt: makeFakePrompt(true),
  });
  deps.aws.volumeList = [
    { id: "vol-0000000000000000a", zone: "us-east-1a", state: "available", active: true, retired: false },
  ];
  return deps;
}

export async function runQuickstart(markdown: string): Promise<ReadonlyArray<QuickstartResult>> {
  const commands = extractCommands(markdown);
  if (commands.length === 0)
    return [{ command: "(none)", exitCode: 2, problem: "no `dozebox` command in a bash block" }];
  const deps = fakeDeps();
  const results: QuickstartResult[] = [];
  for (const command of commands) {
    const err: string[] = [];
    const exitCode = await dispatch(
      COMMANDS,
      {
        argv: splitArgs(command).slice(1),
        stdout: () => {},
        stderr: (l) => void err.push(l),
        env: {},
        signal: new AbortController().signal,
        deps,
      },
      "operator",
    );
    const first = err.find((l) => l.startsWith("dozebox:")) ?? err[0] ?? "";
    const problem =
      exitCode === 0
        ? null
        : first.includes("unknown command")
          ? `unknown command (${first})`
          : `exit ${exitCode}: ${first}`;
    results.push({ command, exitCode, problem });
  }
  return results;
}

if (import.meta.main) {
  if (!process.argv.includes("--dry-run")) {
    process.stderr.write("run-quickstart only runs against fakes: pass --dry-run\n");
    process.exitCode = 2;
  } else {
    const results = await runQuickstart(
      readFileSync(join(import.meta.dirname, "..", "..", "docs", "quickstart.md"), "utf8"),
    );
    for (const r of results)
      process.stdout.write(
        `${r.problem === null ? "ok  " : "FAIL"} ${r.command}${r.problem === null ? "" : `  <- ${r.problem}`}\n`,
      );
    process.exitCode = results.every((r) => r.problem === null) ? 0 : 1;
  }
}
