// Shared by the D2 and D3 drill tests: a drill context over the fakes, an AWS CLI router that refuses calls nobody
// scripted, a fake of SSM Run Command, and a runner that plays steps with their deadlines and then the teardown.
import { controlStatusFixture, makeFakeCliDeps, stackOutputsFixture, type FakeCliDeps } from "@dozebox/testkit/fakes";
import { stackFromOutputs } from "../src/stack.ts";
import type { CliRun, Drill, DrillContext, DrillOptions } from "../src/drills/types.ts";

export const BOX_OUTPUTS = {
  tag_prefix: "dozebox",
  control_function_name: "dozebox-main-control",
  alert_topic_arn: "arn:aws:sns:us-east-1:111122223333:dozebox-main-alerts",
};

export type Route = (args: ReadonlyArray<string>) => unknown;

/** Routes a call by its first two words (`ec2 describe-instances`); any call that is not routed fails the test. */
export function router(routes: Readonly<Record<string, Route>>): Route {
  return (args) => {
    const route = routes[`${args[0] ?? ""} ${args[1] ?? ""}`];
    if (route === undefined) throw new Error(`unscripted aws call: ${args.slice(0, 4).join(" ")}`);
    return route(args);
  };
}

export const after = (args: ReadonlyArray<string>, flag: string): string => args[args.indexOf(flag) + 1] ?? "";

export type TestCtx = DrillContext & { readonly deps: FakeCliDeps; readonly cliCalls: Array<ReadonlyArray<string>> };

export function makeCtx(opts: {
  readonly cli: (argv: ReadonlyArray<string>) => CliRun | Promise<CliRun>;
  readonly options?: Partial<DrillOptions>;
}): TestCtx {
  const outputs = stackOutputsFixture(BOX_OUTPUTS);
  const deps = makeFakeCliDeps({ status: controlStatusFixture(), outputs });
  const cliCalls: Array<ReadonlyArray<string>> = [];
  return {
    runId: "run-1",
    stackDir: "stack",
    nonce: "n1",
    log: () => {},
    stack: async () => stackFromOutputs("stack", outputs),
    deps,
    options: { withHold: false, extras: [], keep: false, deliver: null, broken: null, ...opts.options },
    cli: async (argv) => (cliCalls.push(argv), opts.cli(argv)),
    facts: new Map(),
    cliCalls,
  };
}

export const ok = (json: unknown): CliRun => ({ code: 0, json, out: [] });

/** Fake SSM Run Command: every script sent is kept; `stdout` decides what the command printed. */
/** A ListCommandInvocations --details answer. */
export const invocation = (status: string, code: number, output = ""): unknown => ({
  CommandInvocations: [{ Status: status, CommandPlugins: [{ ResponseCode: code, Output: output }] }],
});

export function ssmRoutes(
  scripts: string[],
  stdout: (script: string) => string = () => "",
  onSend: (script: string) => void = () => {},
): Record<string, Route> {
  return {
    "ssm send-command": (args) => {
      const commands = (JSON.parse(after(args, "--parameters")) as { readonly commands: ReadonlyArray<string> })
        .commands;
      const script = commands[0] ?? "";
      scripts.push(script);
      onSend(script);
      return { Command: { CommandId: `cmd-${scripts.length}` } };
    },
    "ssm list-command-invocations": () => invocation("Success", 0, stdout(scripts.at(-1) ?? "")),
  };
}

export function instance(over: {
  readonly id: string;
  readonly state: string;
  readonly spot?: boolean;
  readonly group?: string;
}): unknown {
  return {
    InstanceId: over.id,
    State: { Name: over.state },
    InstanceType: "t4g.small",
    Placement: { AvailabilityZone: "us-east-1a" },
    ...(over.spot === true ? { InstanceLifecycle: "spot" } : {}),
    LaunchTime: "2026-11-25T00:00:00.000Z",
    Tags: over.group === undefined ? [] : [{ Key: "aws:autoscaling:groupName", Value: over.group }],
  };
}

export const reservations = (instances: ReadonlyArray<unknown>): unknown => ({
  Reservations: [{ Instances: instances }],
});

export const servingStatus = (id: string, lifecycle: "spot" | "on-demand", machine = "persistent"): unknown => ({
  state: "running",
  frozen: false,
  instance: { id, type: "t4g.small", az: "us-east-1a", launchedAt: "2026-11-25T00:00:00.000Z", lifecycle },
  machine,
  servingSince: "2026-11-25T00:05:00.000Z",
});

export type Played = {
  readonly ran: ReadonlyArray<string>;
  readonly failure: unknown;
  readonly teardownError: unknown;
};

/** Steps in order with their own deadlines (the first failure stops them), then the teardown, like `runDrill`. */
export async function play(drill: Drill, ctx: TestCtx): Promise<Played> {
  const ran: string[] = [];
  let failure: unknown = null;
  for (const step of drill.steps) {
    if (step.when !== undefined && !step.when(ctx.options)) continue;
    ran.push(step.id);
    try {
      await step.run(ctx, ctx.deps.clock.timeout(step.deadlineMs));
    } catch (e) {
      failure = e;
      break;
    }
  }
  let teardownError: unknown = null;
  try {
    await drill.teardown(ctx);
  } catch (e) {
    teardownError = e;
  }
  return { ran, failure, teardownError };
}

export const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
