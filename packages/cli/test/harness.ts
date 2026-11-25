// Runs the CLI dispatcher against fake deps and captures stdout, stderr and the exit code.
import { controlStatusFixture, makeFakeCliDeps, stackOutputsFixture, type FakeCliDeps } from "@dozebox/testkit/fakes";
import type { ControlApi } from "dozebox";
import { COMMANDS } from "../src/commands/index.ts";
import type { ExitCode } from "../src/command.ts";
import { dispatch } from "../src/main.ts";

type ControlStatus = Awaited<ReturnType<ControlApi["status"]>>;

export type Run = {
  readonly code: ExitCode;
  readonly out: ReadonlyArray<string>;
  readonly err: ReadonlyArray<string>;
  /** stdout parsed as one JSON document. */
  readonly json: () => unknown;
};

export function fakeDeps(opts: { readonly status?: ControlStatus; readonly yes?: boolean } = {}): FakeCliDeps {
  return makeFakeCliDeps({ status: opts.status ?? controlStatusFixture(), outputs: stackOutputsFixture() });
}

export async function run(
  deps: FakeCliDeps,
  argv: ReadonlyArray<string>,
  opts: {
    readonly mode?: "operator" | "box";
    readonly signal?: AbortSignal;
    readonly env?: Record<string, string>;
  } = {},
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await dispatch(
    COMMANDS,
    {
      argv,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      env: opts.env ?? {},
      signal: opts.signal ?? new AbortController().signal,
      deps,
    },
    opts.mode ?? "operator",
  );
  return { code, out, err, json: () => JSON.parse(out.join("\n")) };
}

/** Every call a fake recorded that changes state. */
export function mutatingCalls(deps: FakeCliDeps): ReadonlyArray<string> {
  const control = deps.control.calls
    .filter((c) => c.op === "wake" || c.op === "alertsTest" || (c.op === "admin" && !isStatusAdmin(c.arg)))
    .map((c) => `control.${c.op}`);
  const terraform = deps.terraform.calls.filter((c) => c.op === "apply" || c.op === "destroy").map((c) => `tf.${c.op}`);
  const aws = deps.aws.calls.map((c) => `aws.${c.op}`);
  return [...control, ...terraform, ...aws];
}

const isStatusAdmin = (arg: unknown): boolean =>
  typeof arg === "object" && arg !== null && (arg as { readonly action?: unknown }).action === "status";
