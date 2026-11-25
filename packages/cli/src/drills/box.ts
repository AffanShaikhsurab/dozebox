// Drill helpers over the AWS CLI: the box's instances, SSM Run Command on the box, records, polling.
import { DozeboxCliError } from "../command.ts";
import type { DrillContext } from "./types.ts";

type Json = Readonly<Record<string, unknown>>;

const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): ReadonlyArray<unknown> => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** `aws <args> --region <stack region>`. */
export async function aws(ctx: DrillContext, args: ReadonlyArray<string>, signal?: AbortSignal): Promise<Json> {
  const s = await ctx.stack();
  return obj(await ctx.deps.awsCli.json([...args, "--region", s.region], signal));
}

export type BoxInstance = {
  readonly id: string;
  readonly state: string;
  readonly type: string;
  readonly zone: string;
  readonly lifecycle: "spot" | "on-demand";
  /** `aws:autoscaling:groupName`, or null for the persistent instance. */
  readonly group: string | null;
  readonly launchedAt: number;
};

const tagOf = (tags: unknown, key: string): string | null =>
  str(
    arr(tags)
      .map(obj)
      .find((t) => t["Key"] === key)?.["Value"],
  );

/** Every instance tagged to the box that is not terminated, newest first. */
export async function boxInstances(ctx: DrillContext, signal?: AbortSignal): Promise<ReadonlyArray<BoxInstance>> {
  const s = await ctx.stack();
  const out = await aws(
    ctx,
    [
      "ec2",
      "describe-instances",
      "--filters",
      `Name=tag:${s.tagPrefix}:box,Values=${s.boxId}`,
      "Name=instance-state-name,Values=pending,running,stopping,stopped",
    ],
    signal,
  );
  const all = arr(out["Reservations"]).flatMap((r) => arr(obj(r)["Instances"]).map(obj));
  return all
    .map((i) => ({
      id: str(i["InstanceId"]) ?? "",
      state: str(obj(i["State"])["Name"]) ?? "unknown",
      type: str(i["InstanceType"]) ?? "",
      zone: str(obj(i["Placement"])["AvailabilityZone"]) ?? "",
      lifecycle: i["InstanceLifecycle"] === "spot" ? ("spot" as const) : ("on-demand" as const),
      group: tagOf(i["Tags"], "aws:autoscaling:groupName"),
      launchedAt: Date.parse(str(i["LaunchTime"]) ?? "") || 0,
    }))
    .toSorted((a, b) => b.launchedAt - a.launchedAt);
}

/** The running instance, or `problem` naming what there is. */
export async function runningInstance(ctx: DrillContext, signal?: AbortSignal): Promise<BoxInstance> {
  const all = await boxInstances(ctx, signal);
  const running = all.find((i) => i.state === "running");
  if (running !== undefined) return running;
  throw new DozeboxCliError(
    "problem",
    `no running instance (${all.map((i) => `${i.id} ${i.state}`).join(", ") || "none"})`,
  );
}

/** Calls `probe` every `everyMs` until it answers non-null or the signal fires (the step deadline). */
export async function waitUntil<T>(
  ctx: DrillContext,
  signal: AbortSignal,
  everyMs: number,
  probe: () => Promise<T | null>,
): Promise<T> {
  for (;;) {
    if (signal.aborted) throw signal.reason;
    const v = await probe();
    if (v !== null) return v;
    await ctx.deps.clock.sleep(everyMs, signal);
  }
}

export type ShellResult = {
  readonly status: string;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

const DONE = new Set(["Success", "Failed", "Cancelled", "TimedOut", "Undeliverable", "Terminated", "InvalidPlatform"]);

/** Runs `script` as root on the instance through SSM Run Command (AWS-RunShellScript) and waits for it. */
export async function shell(
  ctx: DrillContext,
  instanceId: string,
  script: string,
  signal: AbortSignal,
  opts: { readonly timeoutSeconds?: number; readonly check?: boolean } = {},
): Promise<ShellResult> {
  const timeout = opts.timeoutSeconds ?? 120;
  const sent = await aws(
    ctx,
    [
      "ssm",
      "send-command",
      "--document-name",
      "AWS-RunShellScript",
      "--instance-ids",
      instanceId,
      "--timeout-seconds",
      "60",
      "--parameters",
      JSON.stringify({ commands: [script], executionTimeout: [String(timeout)] }),
    ],
    signal,
  );
  const commandId = str(obj(sent["Command"])["CommandId"]);
  if (commandId === null) throw new DozeboxCliError("aws", "ssm send-command answered no CommandId");
  // ListCommandInvocations, not GetCommandInvocation: a restricted operator may have only the former, and with
  // --details it carries the same status, exit code and output (stdout, then stderr after an ERROR banner).
  const result = await waitUntil(ctx, signal, 2_000, async () => {
    const out = await aws(
      ctx,
      ["ssm", "list-command-invocations", "--command-id", commandId, "--instance-id", instanceId, "--details"],
      signal,
    );
    const inv = obj(arr(out["CommandInvocations"])[0]);
    const status = str(inv["Status"]) ?? "";
    if (!DONE.has(status)) return null;
    const plugin = obj(arr(inv["CommandPlugins"])[0]);
    const output = str(plugin["Output"]) ?? "";
    const [stdout = "", stderr = ""] = output.split(/-{5,}ERROR-{5,}\n?/);
    return {
      status,
      code: typeof plugin["ResponseCode"] === "number" ? plugin["ResponseCode"] : -1,
      stdout,
      stderr,
    };
  });
  if (opts.check !== false && result.status !== "Success") {
    throw new DozeboxCliError(
      "problem",
      `on ${instanceId}: ${result.status} (exit ${result.code}): ${(result.stderr || result.stdout).slice(-400)}`,
    );
  }
  return result;
}

/** A record `/<prefix>/<box>/rec/<name>` parsed, or null when it does not exist. */
export async function record(ctx: DrillContext, name: string, signal?: AbortSignal): Promise<Json | null> {
  const s = await ctx.stack();
  let out: Json;
  try {
    out = await aws(ctx, ["ssm", "get-parameter", "--name", `${s.ssmPrefix}rec/${name}`, "--with-decryption"], signal);
  } catch (e) {
    if (e instanceof DozeboxCliError && e.message.includes("ParameterNotFound")) return null;
    throw e;
  }
  const value = str(obj(out["Parameter"])["Value"]);
  if (value === null) return null;
  try {
    return obj(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Runs a CLI command and fails the step on a non-zero exit, naming the command. */
export async function cliOk(ctx: DrillContext, argv: ReadonlyArray<string>, signal: AbortSignal): Promise<Json> {
  const r = await ctx.cli(argv, signal);
  if (r.code !== 0) {
    throw new DozeboxCliError("problem", `dozebox ${argv.join(" ")} exited ${r.code}: ${r.out.join(" ").slice(-400)}`);
  }
  return obj(r.json);
}

export { arr, obj, str };
