#!/usr/bin/env node
// The `dozebox` command. Wires the real adapters into `CliDeps`, then hands over to the dispatcher.
import { existsSync } from "node:fs";
import { setTimeout as sleepFor } from "node:timers/promises";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { createClient } from "@dozebox/client";
import type { Clock } from "@dozebox/core/time";
import { makeControlApi } from "./adapters/control.ts";
import { makeExec, nodeExecSpawn } from "./adapters/exec.ts";
import { makeCliFiles } from "./adapters/files.ts";
import { makeLambdaAdmin } from "./adapters/aws/lambda-admin.ts";
import { makeAwsOps } from "./adapters/aws/ops.ts";
import { makeAwsCli, nodeAwsSpawn } from "./adapters/aws/cli.ts";
import { functionUrlRegion, makeSigner } from "./adapters/aws/sign.ts";
import { makePrompt } from "./adapters/prompt.ts";
import { makeTerraform, nodeTerraformSpawn } from "./adapters/terraform.ts";
import { makeTools, runCapture } from "./adapters/tools.ts";
import { DozeboxCliError, type CliDeps, type CommandContext } from "./command.ts";
import { COMMANDS } from "./commands/index.ts";
import { DEFAULT_STACK_DIR } from "./context.ts";
import { dispatch, GLOBAL_OPTIONS } from "./main.ts";
import type { AwsOps } from "./ports/aws.ts";
import type { ControlApi } from "./ports/control.ts";
import { readStack, type StackContext } from "./stack.ts";

const realClock: Clock = {
  now: () => Date.now(),
  sleep: async (ms, signal) => {
    try {
      await sleepFor(ms, undefined, signal === undefined ? {} : { signal });
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      throw e;
    }
  },
  timeout: (ms) => AbortSignal.timeout(ms),
};

const stderr = (text: string): void => void process.stderr.write(text);

/** An object whose methods wait for `get()` (built once, on first use) and then call the real one. */
function lazy<T extends object>(get: () => Promise<T>): T {
  const real = (): Promise<Record<PropertyKey, (...args: unknown[]) => unknown>> =>
    get() as unknown as Promise<Record<PropertyKey, (...args: unknown[]) => unknown>>;
  return new Proxy({} as T, {
    get: (_target, prop) =>
      prop === "then" ? undefined : async (...args: unknown[]) => (await real().then((r) => r[prop]))?.(...args),
  });
}

/** `/dozebox/main/` -> `/dozebox/shared/`. */
function sharedPathOf(ssmPrefix: string): string {
  const parts = ssmPrefix.replace(/\/+$/, "").split("/");
  parts[parts.length - 1] = "shared";
  return `${parts.join("/")}/`;
}

async function run(args: ReadonlyArray<string>, mode: "operator" | "box"): Promise<void> {
  const abort = new AbortController();
  let interrupts = 0;
  process.on("SIGINT", () => {
    if (++interrupts > 1) process.exit(130);
    abort.abort();
  });

  const base = {
    clock: realClock,
    terraform: makeTerraform({ spawn: nodeTerraformSpawn, stderr }),
    fs: makeCliFiles(),
    prompt: makePrompt({ stdin: process.stdin, stderr }),
    tools: makeTools({ run: runCapture, nodeVersion: process.versions.node }),
    exec: makeExec({ spawn: nodeExecSpawn, stdout: (c) => void process.stdout.write(c), stderr }),
    ids: { random: randomUUID },
    awsCli: makeAwsCli({ spawn: nodeAwsSpawn }),
  };

  const stackDir = parseArgs({ args: [...args], options: GLOBAL_OPTIONS, strict: false, allowPositionals: true })
    .values["stack"];
  let stack: Promise<StackContext> | null = null;
  const getStack = (): Promise<StackContext> =>
    (stack ??= readStack(base, typeof stackDir === "string" ? stackDir : DEFAULT_STACK_DIR, { refresh: false }));

  // bootstrap and doctor run before a stack exists: then the region comes from the environment.
  const aws = lazy<AwsOps>(async () => {
    const s = await getStack().catch((e: unknown) => {
      if (e instanceof DozeboxCliError && e.code === "not-set-up") return null;
      throw e;
    });
    if (s === null) {
      const region = process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? "us-east-1";
      return makeAwsOps({ region, tagPrefix: "dozebox", sharedPath: "/dozebox/shared/" });
    }
    return makeAwsOps({ region: s.region, tagPrefix: s.tagPrefix, sharedPath: sharedPathOf(s.ssmPrefix) });
  });

  const control = lazy<ControlApi>(async () => {
    const s = await getStack();
    const urlRegion = functionUrlRegion(s.controlUrl);
    return makeControlApi({
      controlUrl: s.controlUrl,
      functionName: s.controlFunctionName,
      token: async () => {
        const token = await aws.getParameter(s.wakeTokenParameter);
        if (token === null) {
          throw new DozeboxCliError(
            "not-set-up",
            `No wake token at ${s.wakeTokenParameter}; run \`dozebox setup\` first.`,
          );
        }
        return token;
      },
      fetch,
      clock: realClock,
      sign: urlRegion === null ? null : makeSigner({ region: urlRegion }),
      invokeAdmin: makeLambdaAdmin({ region: s.region, functionName: s.controlFunctionName }),
    });
  });

  let agentSocket: CliDeps["agentSocket"] = null;
  if (mode === "box") {
    try {
      agentSocket = createClient();
    } catch {
      agentSocket = null;
    }
  }

  const ctx: CommandContext = {
    argv: args,
    stdout: (line) => void process.stdout.write(`${line}\n`),
    stderr: (line) => void process.stderr.write(`${line}\n`),
    env: process.env,
    signal: abort.signal,
    deps: { ...base, control, aws, agentSocket },
  };
  process.exitCode = await dispatch(COMMANDS, ctx, mode);
}

await run(process.argv.slice(2), existsSync("/run/dozebox/") ? "box" : "operator");
