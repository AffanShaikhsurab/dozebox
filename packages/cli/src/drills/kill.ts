// D3: `dozebox drill kill`. The kill switch on a serving box: the deny policy on the box and control roles, the
// instance stopped, every group at 0, the box frozen, and the alert topic published; then `dozebox unfreeze` and a
// wake that serves. The alarm goes to ALARM with `set-alarm-state` instead of waiting 24 hours for the cap: that fires
// the same alarm actions (the alert topic and the EventBridge rule that starts the kill runbook) without editing the
// alarm, so the Terraform plan stays clean.
import { MINUTE, SECOND } from "@dozebox/core/time";
import { DozeboxCliError } from "../command.ts";
import { aws, arr, boxInstances, cliOk, obj, str, waitUntil } from "./box.ts";
import { attemptAll, parkAndWait, servingOf, stackName, teardownSignal, wakeServing } from "./parked.ts";
import type { Drill, DrillContext } from "./types.ts";

const SERVING_DEADLINE = 15 * MINUTE;

const iso = (ms: number): string => new Date(ms).toISOString();

const text = (ctx: DrillContext, k: string): string => {
  const v = ctx.facts.get(k);
  if (typeof v !== "string") throw new DozeboxCliError("problem", `an earlier step did not record ${k}`);
  return v;
};

/** The kill alarm that exists in the stack (`awake` first), found by its exact name. */
async function killAlarm(ctx: DrillContext, signal: AbortSignal): Promise<string> {
  const name = await stackName(ctx);
  const wanted = [`${name}-kill-awake`, `${name}-kill-on-demand`];
  const out = await aws(ctx, ["cloudwatch", "describe-alarms", "--alarm-names", ...wanted], signal);
  const found = arr(out["MetricAlarms"]).map((a) => str(obj(a)["AlarmName"]));
  const alarm = wanted.find((w) => found.includes(w));
  if (alarm === undefined) throw new DozeboxCliError("problem", `none of ${wanted.join(", ")} exists in the stack`);
  return alarm;
}

const setAlarm = (ctx: DrillContext, alarm: string, value: "ALARM" | "OK", signal: AbortSignal) =>
  aws(
    ctx,
    [
      "cloudwatch",
      "set-alarm-state",
      "--alarm-name",
      alarm,
      "--state-value",
      value,
      "--state-reason",
      "dozebox drill kill",
    ],
    signal,
  );

/** True when `role` has the deny policy, false when not, null when IAM refuses the question (recorded, not fatal). */
async function denied(ctx: DrillContext, role: string, signal: AbortSignal): Promise<boolean | null> {
  const deny = `${await stackName(ctx)}-frozen`;
  try {
    const out = await aws(ctx, ["iam", "list-attached-role-policies", "--role-name", role], signal);
    return arr(out["AttachedPolicies"]).some((p) => str(obj(p)["PolicyName"]) === deny);
  } catch (e) {
    if (e instanceof DozeboxCliError && /AccessDenied|not authorized/i.test(e.message)) {
      ctx.facts.set("kill.denyCheck", `unverifiable: ${e.message.slice(0, 120)}`);
      return null;
    }
    throw e;
  }
}

async function roles(ctx: DrillContext): Promise<ReadonlyArray<string>> {
  const name = await stackName(ctx);
  return [`${name}-box`, `${name}-control`];
}

/** What is not yet as a frozen box must be; empty when the freeze is complete. */
async function freezeProblems(ctx: DrillContext, signal: AbortSignal): Promise<ReadonlyArray<string>> {
  const problems: string[] = [];
  const name = await stackName(ctx);
  for (const i of await boxInstances(ctx, signal)) {
    if (i.state !== "stopped") problems.push(`${i.id} is ${i.state}`);
  }
  const groups = await aws(
    ctx,
    ["autoscaling", "describe-auto-scaling-groups", "--auto-scaling-group-names", name, `${name}-od`],
    signal,
  );
  for (const g of arr(groups["AutoScalingGroups"]).map(obj)) {
    if (g["DesiredCapacity"] !== 0) {
      problems.push(`group ${str(g["AutoScalingGroupName"]) ?? "?"} is at ${String(g["DesiredCapacity"])}`);
    }
  }
  for (const role of await roles(ctx)) {
    if ((await denied(ctx, role, signal)) === false) problems.push(`${role} has no deny policy`);
  }
  if ((await cliOk(ctx, ["status"], signal))["frozen"] !== true) problems.push("status does not say frozen");
  return problems;
}

async function liftProblems(ctx: DrillContext, signal: AbortSignal): Promise<ReadonlyArray<string>> {
  const problems: string[] = [];
  for (const role of await roles(ctx)) {
    if ((await denied(ctx, role, signal)) === true) problems.push(`${role} still has the deny policy`);
  }
  if ((await cliOk(ctx, ["status"], signal))["frozen"] === true) problems.push("status still says frozen");
  return problems;
}

/** Polls `check` until it reports no problem; a missed deadline names the last problems seen. */
async function waitClean(
  ctx: DrillContext,
  signal: AbortSignal,
  what: string,
  check: () => Promise<ReadonlyArray<string>>,
): Promise<void> {
  let last: ReadonlyArray<string> = ["not checked yet"];
  try {
    await waitUntil(ctx, signal, 10 * SECOND, async () => {
      last = await check();
      return last.length === 0 ? true : null;
    });
  } catch (e) {
    if (!signal.aborted) throw e;
    throw new DozeboxCliError("problem", `${what}: ${last.join("; ")}`, { cause: e });
  }
}

/** The alarm's SNS action ran for the alert topic, or the topic's published-message metric moved. */
async function alertPublished(ctx: DrillContext, alarm: string, since: number, signal: AbortSignal): Promise<boolean> {
  const topicArn = (await ctx.stack()).alertTopicArn;
  const history = await aws(
    ctx,
    [
      "cloudwatch",
      "describe-alarm-history",
      "--alarm-name",
      alarm,
      "--history-item-type",
      "Action",
      "--start-date",
      iso(since),
    ],
    signal,
  );
  const ran = arr(history["AlarmHistoryItems"]).some((i) => {
    const summary = str(obj(i)["HistorySummary"]) ?? "";
    return summary.includes(topicArn) && /Successfully executed/i.test(summary);
  });
  if (ran) return true;
  const topic = topicArn.split(":").at(-1) ?? "";
  const stats = await aws(
    ctx,
    [
      "cloudwatch",
      "get-metric-statistics",
      "--namespace",
      "AWS/SNS",
      "--metric-name",
      "NumberOfMessagesPublished",
      "--dimensions",
      `Name=TopicName,Value=${topic}`,
      "--start-time",
      iso(since - MINUTE),
      "--end-time",
      iso(ctx.deps.clock.now() + 5 * MINUTE),
      "--period",
      "60",
      "--statistics",
      "Sum",
    ],
    signal,
  );
  return arr(stats["Datapoints"]).some((d) => Number(obj(d)["Sum"]) > 0);
}

async function unfreezeIfFrozen(ctx: DrillContext, signal: AbortSignal): Promise<void> {
  if ((await cliOk(ctx, ["status"], signal))["frozen"] !== true) return;
  await cliOk(ctx, ["unfreeze", "--reason", "drill kill teardown"], signal);
  await waitClean(ctx, signal, "teardown unfreeze", () => liftProblems(ctx, signal));
}

export const killDrill: Drill = {
  name: "kill",
  // One short Spot run before the freeze and one after the unfreeze (t4g.small about $0.006 an hour).
  estimateUsd: async () => 0.03,
  steps: [
    {
      id: "serve",
      deadlineMs: SERVING_DEADLINE,
      run: async (ctx, signal) => {
        const s = servingOf(await wakeServing(ctx, signal));
        ctx.facts.set("kill.instance", s.id);
        ctx.facts.set("kill.alarm", await killAlarm(ctx, signal));
      },
    },
    {
      id: "trip",
      deadlineMs: 2 * MINUTE,
      run: async (ctx, signal) => {
        ctx.facts.set("kill.trippedAt", String(ctx.deps.clock.now()));
        ctx.facts.set("kill.tripped", true);
        await setAlarm(ctx, text(ctx, "kill.alarm"), "ALARM", signal);
      },
    },
    {
      id: "frozen",
      deadlineMs: 10 * MINUTE,
      run: async (ctx, signal) => {
        await waitClean(ctx, signal, "the kill switch did not complete", () => freezeProblems(ctx, signal));
      },
    },
    {
      id: "alert",
      deadlineMs: 10 * MINUTE,
      run: async (ctx, signal) => {
        const since = Number(text(ctx, "kill.trippedAt")) - MINUTE;
        const alarm = text(ctx, "kill.alarm");
        await waitClean(ctx, signal, "the alert topic was not published", async () =>
          (await alertPublished(ctx, alarm, since, signal)) ? [] : ["no SNS publish seen for the alarm"],
        );
      },
    },
    {
      id: "unfreeze",
      deadlineMs: 10 * MINUTE,
      run: async (ctx, signal) => {
        await setAlarm(ctx, text(ctx, "kill.alarm"), "OK", signal);
        ctx.facts.set("kill.tripped", false);
        await cliOk(ctx, ["unfreeze", "--reason", "drill kill"], signal);
        await waitClean(ctx, signal, "the unfreeze did not complete", () => liftProblems(ctx, signal));
      },
    },
    {
      id: "wake-again",
      deadlineMs: SERVING_DEADLINE,
      run: async (ctx, signal) => {
        servingOf(await wakeServing(ctx, signal));
      },
    },
  ],
  teardown: async (ctx) => {
    const signal = teardownSignal(ctx);
    await attemptAll(ctx, [
      [
        "alarm back to OK",
        async () => {
          if (ctx.facts.get("kill.tripped") === true) await setAlarm(ctx, text(ctx, "kill.alarm"), "OK", signal);
        },
      ],
      ["unfreeze", () => unfreezeIfFrozen(ctx, signal)],
      ["park", () => parkAndWait(ctx, signal)],
    ]);
  },
};
