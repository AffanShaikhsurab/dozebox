// D1: `dozebox drill <name>` runs one drill of the catalog against the stack and writes its JSON report.
import { DozeboxCliError, EXIT, type Command, type CommandContext, type ExitCode } from "../command.ts";
import { stackDirOf } from "../context.ts";
import { DRILLS } from "../drills/catalog.ts";
import { runDrill } from "../drills/run.ts";
import type { CliRun, Drill, DrillContext, DrillOptions } from "../drills/types.ts";
import { dispatch } from "../main.ts";
import { positionals, say, stringOpt, type Values } from "../output.ts";
import { readStack } from "../stack.ts";

const DEFAULT_TEST_BUDGET_USD = 10;

const list = (values: Values, name: string): ReadonlyArray<string> =>
  (stringOpt(values, name) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

function testBudget(values: Values): number {
  const raw = stringOpt(values, "test-budget");
  if (raw === undefined) return DEFAULT_TEST_BUDGET_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0)
    throw new DozeboxCliError("usage", "--test-budget must be a positive number of USD");
  return n;
}

const optionsOf = (values: Values): DrillOptions => ({
  withHold: values["with-hold"] === true,
  extras: list(values, "extra"),
  keep: values["keep"] === true,
  deliver: stringOpt(values, "deliver") ?? null,
  broken: stringOpt(values, "broken") ?? null,
});

/** `<name>-yyyymmddHHMMss` in UTC. */
const runIdOf = (name: string, now: number): string =>
  `${name}-${new Date(now).toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;

async function nonceOf(ctx: CommandContext, values: Values, dir: string): Promise<string> {
  const given = stringOpt(values, "nonce");
  if (given !== undefined) return given;
  try {
    const v = (await ctx.deps.terraform.output(dir))["marker_nonce"]?.value;
    if (typeof v === "string" && v !== "") return v;
  } catch {
    // no stack yet (a drill that deploys one): a random nonce
  }
  return ctx.deps.ids.random();
}

function makeContext(
  ctx: CommandContext,
  commands: () => ReadonlyArray<Command>,
  p: { readonly runId: string; readonly dir: string; readonly nonce: string; readonly options: DrillOptions },
): DrillContext {
  const log = (line: string): void => ctx.stderr(`[drill ${p.runId}] ${line}`);
  return {
    runId: p.runId,
    stackDir: p.dir,
    nonce: p.nonce,
    log,
    stack: () => readStack(ctx.deps, p.dir, { refresh: false }),
    deps: ctx.deps,
    options: p.options,
    facts: new Map(),
    cli: async (argv, signal): Promise<CliRun> => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await dispatch(
        commands(),
        {
          argv: [...argv, "--stack", p.dir, "--json", "--yes"],
          stdout: (l) => out.push(l),
          stderr: (l) => (err.push(l), log(l)),
          env: ctx.env,
          signal,
          deps: ctx.deps,
        },
        "operator",
      );
      let json: unknown = null;
      try {
        json = JSON.parse(out.join("\n"));
      } catch {
        // not a JSON document (usage errors print text): null
      }
      return { code, json, out: [...err, ...out] };
    },
  };
}

/** `commands` is the full command list (the drill runs other commands through the dispatcher). */
export function drillCommand(commands: () => ReadonlyArray<Command>, drills: ReadonlyArray<Drill> = DRILLS): Command {
  return {
    name: "drill",
    summary: "Run a real-AWS drill: smoke, spot, fallback, kill, front-door, restore.",
    options: {
      skip: { type: "string" },
      report: { type: "string" },
      "with-hold": { type: "boolean" },
      extra: { type: "string" },
      keep: { type: "boolean" },
      deliver: { type: "string" },
      broken: { type: "string" },
      nonce: { type: "string" },
      "test-budget": { type: "string" },
    },
    mode: "operator",
    mutates: true,
    run: async (ctx, values, given) => {
      if (values["dry-run"] === true)
        throw new DozeboxCliError("usage", "drills act on real AWS; --dry-run is not supported");
      const [name] = positionals(given, ["name"]);
      const drill = drills.find((d) => d.name === name);
      if (drill === undefined) {
        throw new DozeboxCliError(
          "usage",
          `unknown drill: ${name}; the drills are ${drills.map((d) => d.name).join(", ")}`,
        );
      }
      const budget = testBudget(values);
      const dir = stackDirOf(values);
      const runId = runIdOf(drill.name, ctx.deps.clock.now());
      const dctx = makeContext(ctx, commands, {
        runId,
        dir,
        nonce: await nonceOf(ctx, values, dir),
        options: optionsOf(values),
      });
      const report = await runDrill(drill, dctx, {
        testBudgetUsd: budget,
        skip: list(values, "skip"),
        signal: ctx.signal,
      });
      await ctx.deps.fs.writeText(
        stringOpt(values, "report") ?? `drills/${runId}.json`,
        `${JSON.stringify(report, null, 2)}\n`,
      );
      const seconds = report.steps.reduce((a, s) => a + s.ms, 0) / 1000;
      const verdict = report.ok
        ? "ok"
        : report.refused !== undefined
          ? `refused (${report.refused})`
          : report.blocked !== undefined
            ? `blocked (${report.blocked})`
            : "FAILED";
      say(ctx, values, `drill ${drill.name} ${verdict}: ${report.steps.length} steps, ${seconds.toFixed(1)} s`);
      const exitCode: ExitCode = report.ok ? EXIT.ok : report.refused !== undefined ? EXIT.refused : EXIT.problem;
      return { exitCode, json: report };
    },
  };
}
