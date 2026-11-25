import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DozeboxCliError } from "../src/command.ts";
import { makeFrontDoorDrill } from "../src/drills/front-door.ts";
import { killDrill } from "../src/drills/kill.ts";
import { restoreDrill } from "../src/drills/restore.ts";
import {
  after,
  instance,
  makeCtx,
  message,
  ok,
  play,
  reservations,
  router,
  servingStatus,
  type Route,
  type TestCtx,
} from "./d23-support.ts";

const TOPIC = "arn:aws:sns:us-east-1:111122223333:dozebox-main-alerts";
const KILL_STEPS = ["serve", "trip", "frozen", "alert", "unfreeze", "wake-again"];

type KillOpts = { readonly noSnsAction?: boolean; readonly iamDenied?: boolean };

/** A serving box; ALARM on the kill alarm plays the kill runbook, `unfreeze` plays the unfreeze runbook. */
function killWorld(opts: KillOpts = {}) {
  const w = { state: "stopped", frozen: false, denied: false, alarm: [] as string[] };
  const ctx = makeCtx({
    cli: (argv) => {
      if (argv[0] === "wake") {
        w.state = "running";
        return ok(servingStatus("i-1", "spot"));
      }
      if (argv[0] === "status") return ok({ ...(servingStatus("i-1", "spot") as object), frozen: w.frozen });
      if (argv[0] === "unfreeze") {
        w.frozen = false;
        w.denied = false;
      }
      if (argv[0] === "park") w.state = "stopped";
      return ok({});
    },
  });
  ctx.deps.awsCli.answer = router({
    "cloudwatch describe-alarms": () => ({ MetricAlarms: [{ AlarmName: "dozebox-main-kill-awake" }] }),
    "cloudwatch set-alarm-state": (args) => {
      const value = after(args, "--state-value");
      w.alarm.push(`${after(args, "--alarm-name")}=${value}`);
      if (value === "ALARM") Object.assign(w, { state: "stopped", frozen: true, denied: true });
      return null;
    },
    "cloudwatch describe-alarm-history": () => ({
      AlarmHistoryItems: opts.noSnsAction === true ? [] : [{ HistorySummary: `Successfully executed action ${TOPIC}` }],
    }),
    "cloudwatch get-metric-statistics": () => ({ Datapoints: [] }),
    "ec2 describe-instances": () => reservations([instance({ id: "i-1", state: w.state, spot: true })]),
    "autoscaling describe-auto-scaling-groups": () => ({
      AutoScalingGroups: [{ AutoScalingGroupName: "dozebox-main-od", DesiredCapacity: 0 }],
    }),
    "iam list-attached-role-policies": () => {
      if (opts.iamDenied === true) throw new DozeboxCliError("aws", "AccessDenied: iam:ListAttachedRolePolicies");
      return { AttachedPolicies: w.denied ? [{ PolicyName: "dozebox-main-frozen" }] : [] };
    },
  });
  return { ctx, w };
}

describe("drill kill", () => {
  it("freezes the box through the alarm, sees the page, unfreezes and wakes again", async () => {
    const { ctx, w } = killWorld();
    const r = await play(killDrill, ctx);
    assert.equal(r.failure, null, message(r.failure));
    assert.equal(r.teardownError, null);
    assert.deepEqual(r.ran, KILL_STEPS);
    assert.deepEqual(w.alarm, ["dozebox-main-kill-awake=ALARM", "dozebox-main-kill-awake=OK"]);
    assert.ok(ctx.cliCalls.some((c) => c[0] === "unfreeze" && c.includes("--reason")));
    assert.equal(w.denied, false);
    assert.equal(ctx.cliCalls.at(-1)?.[0], "park");
  });

  it("names what is missing when the freeze never completes, then unfreezes in teardown", async () => {
    const { ctx, w } = killWorld();
    // The runbook half works: the deny policy is on, the instance keeps running.
    const base = ctx.deps.awsCli.answer;
    ctx.deps.awsCli.answer = (args) => {
      if (args[1] === "set-alarm-state" && after(args, "--state-value") === "ALARM") {
        Object.assign(w, { frozen: true, denied: true });
        w.alarm.push("dozebox-main-kill-awake=ALARM");
        return null;
      }
      return base(args);
    };
    const r = await play(killDrill, ctx);
    assert.equal(r.ran.at(-1), "frozen");
    assert.match(message(r.failure), /i-1 is running/);
    assert.equal(r.teardownError, null);
    assert.equal(w.frozen, false, "teardown ran the unfreeze");
    assert.deepEqual(w.alarm.at(-1), "dozebox-main-kill-awake=OK");
    assert.equal(ctx.cliCalls.at(-1)?.[0], "park");
  });

  it("fails when the alert topic was not published, and unfreezes in teardown", async () => {
    const { ctx, w } = killWorld({ noSnsAction: true });
    const r = await play(killDrill, ctx);
    assert.equal(r.ran.at(-1), "alert");
    assert.match(message(r.failure), /not published/);
    assert.equal(w.frozen, false);
    assert.equal(w.denied, false);
  });

  it("uses the freeze status when IAM will not say which policies are attached", async () => {
    const { ctx } = killWorld({ iamDenied: true });
    const r = await play(killDrill, ctx);
    assert.equal(r.failure, null, message(r.failure));
    assert.match(String(ctx.facts.get("kill.denyCheck")), /unverifiable/);
  });

  it("does not touch the alarm in teardown when it never tripped it", async () => {
    const { ctx, w } = killWorld();
    const base = ctx.deps.awsCli.answer;
    ctx.deps.awsCli.answer = (args) => {
      if (args[1] === "describe-alarms") return { MetricAlarms: [] };
      return base(args);
    };
    const r = await play(killDrill, ctx);
    assert.deepEqual(r.ran, ["serve"]);
    assert.match(message(r.failure), /exists in the stack/);
    assert.deepEqual(w.alarm, []);
  });
});

type RestoreOpts = {
  readonly verdictOk?: boolean;
  readonly scratchTags?: "mine" | "foreign";
  /** The control function's own restore test has a volume at the baseline that is gone by the end. */
  readonly inFlight?: boolean;
};

const vol = (id: string, active: boolean, state = "in-use", extra: object = {}): unknown => ({
  VolumeId: id,
  State: state,
  AvailabilityZone: "us-east-1a",
  Tags: [
    { Key: "dozebox:box", Value: "main" },
    { Key: "dozebox:active", Value: String(active) },
  ],
  Attachments: [],
  ...extra,
});

/** One active volume, one snapshot; the control function's tick answers on the second read of `kv#restore-test`. */
function restoreWorld(opts: RestoreOpts = {}) {
  const w = {
    reads: 0,
    listed: 0,
    puts: [] as string[],
    created: [] as string[],
    deleted: [] as string[],
    scratch: false,
  };
  const ctx = makeCtx({ cli: () => ok({}) });
  const routes: Record<string, Route> = {
    "ec2 describe-snapshots": () => ({
      Snapshots: [
        { SnapshotId: "snap-old", StartTime: "2026-11-20T00:00:00Z" },
        { SnapshotId: "snap-new", StartTime: "2026-11-24T00:00:00Z" },
      ],
    }),
    "ec2 describe-volumes": (args) => {
      if (args.includes("--volume-ids")) {
        const mine = opts.scratchTags !== "foreign";
        return {
          Volumes: [
            {
              ...(vol("vol-new", false, "available") as object),
              Tags: [
                { Key: "dozebox:box", Value: "main" },
                { Key: "dozebox:active", Value: "false" },
                ...(mine ? [{ Key: "dozebox:drill", Value: "n1" }] : []),
              ],
            },
          ],
        };
      }
      w.listed++;
      const inFlight = opts.inFlight === true && w.listed === 1 ? [vol("vol-ctl", false, "available")] : [];
      return { Volumes: [vol("vol-a", true), ...inFlight, ...(w.scratch ? [vol("vol-new", false, "available")] : [])] };
    },
    "ec2 create-volume": () => {
      w.created.push("vol-new");
      w.scratch = true;
      return { VolumeId: "vol-new" };
    },
    "ec2 delete-volume": (args) => {
      w.deleted.push(after(args, "--volume-id"));
      w.scratch = false;
      return null;
    },
    "dynamodb get-item": (args) => {
      if (after(args, "--key").includes("lease#")) return { Item: { fencing: { N: "9" } } };
      w.reads++;
      const result = {
        phase: "idle",
        lastResult: {
          at: w.reads < 3 ? 0 : ctx.deps.clock.now(),
          ok: opts.verdictOk !== false,
          snapshotId: "snap-new",
          detail: opts.verdictOk === false ? "volume error" : "restored 20 GiB, available",
        },
      };
      return w.puts.length === 0 ? {} : { Item: { value: { S: JSON.stringify(result) } } };
    },
    "dynamodb put-item": (args) => {
      w.puts.push(after(args, "--item"));
      return null;
    },
  };
  ctx.deps.awsCli.answer = router(routes);
  return { ctx: ctx as TestCtx, w };
}

describe("drill restore", () => {
  it("makes the weekly test due and passes on the control function's verdict", async () => {
    const { ctx, w } = restoreWorld();
    const r = await play(restoreDrill, ctx);
    assert.equal(r.failure, null, message(r.failure));
    assert.deepEqual(r.ran, ["baseline", "make-due", "verdict", "one-active"]);
    assert.equal(ctx.facts.get("restore.path"), "control");
    const due = JSON.parse(w.puts[0] ?? "{}") as { value: { S: string }; fencing: { N: string } };
    assert.equal(due.fencing.N, "9");
    assert.deepEqual(JSON.parse(due.value.S), {
      phase: "idle",
      lastResult: { at: 0, ok: true, snapshotId: "", detail: "drill: made due" },
    });
    assert.deepEqual(w.created, [], "the control function creates the volume, not the drill");
  });

  it("passes when the control function's own scratch volume was in flight at the baseline", async () => {
    const { ctx } = restoreWorld({ inFlight: true });
    const r = await play(restoreDrill, ctx);
    assert.equal(r.failure, null, message(r.failure));
    assert.match(String(ctx.facts.get("restore.before")), /vol-ctl/);
  });

  it("fails with the control function's detail when the test failed", async () => {
    const { ctx } = restoreWorld({ verdictOk: false });
    const r = await play(restoreDrill, ctx);
    assert.equal(r.ran.at(-1), "verdict");
    assert.match(message(r.failure), /volume error/);
  });

  it("with restore-direct creates one scratch volume from the newest snapshot and deletes only that one", async () => {
    const { ctx, w } = restoreWorld();
    Object.assign(ctx.options, { extras: ["restore-direct"] });
    const r = await play(restoreDrill, ctx);
    assert.equal(r.failure, null, message(r.failure));
    assert.deepEqual(r.ran, ["baseline", "create-scratch", "scratch-available", "delete-scratch", "one-active"]);
    assert.deepEqual(w.created, ["vol-new"]);
    assert.deepEqual(w.deleted, ["vol-new"]);
    const create = ctx.deps.awsCli.calls.find((c) => c[1] === "create-volume") ?? [];
    assert.equal(after(create, "--snapshot-id"), "snap-new");
    assert.match(after(create, "--tag-specifications"), /"dozebox:active","Value":"false"/);
  });

  it("refuses to delete a volume that is not tagged with this drill's nonce", async () => {
    const { ctx, w } = restoreWorld({ scratchTags: "foreign" });
    Object.assign(ctx.options, { extras: ["restore-direct"] });
    const r = await play(restoreDrill, ctx);
    assert.equal(r.ran.at(-1), "delete-scratch");
    assert.match(message(r.failure), /refusing to delete/);
    assert.deepEqual(w.deleted, []);
    assert.match(message(r.teardownError), /refusing to delete/);
  });
});

function withDomain(cli: (argv: ReadonlyArray<string>) => ReturnType<typeof ok>): TestCtx {
  const base = makeCtx({ cli });
  return {
    ...base,
    stack: async () => ({ ...(await base.stack()), frontDoorDomain: "d111111abcdef8.cloudfront.net" }),
  };
}

describe("drill front-door", () => {
  it("fails when a wrong token is not refused", async () => {
    const ctx = withDomain(() => ok({}));
    ctx.deps.aws.params.set("/dozebox/main/wake-token", { value: "t", secure: true });
    const drill = makeFrontDoorDrill(async () => new Response(JSON.stringify({ v: 1 }), { status: 200 }));
    const r = await play(drill, ctx);
    assert.deepEqual(r.ran, ["enable", "status", "wrong-token"]);
    assert.match(message(r.failure), /answered 200, want 401/);
  });

  it("teardown turns the front door off even when the park fails", async () => {
    const ctx = withDomain((argv) => (argv[0] === "park" ? { code: 1, json: null, out: ["no"] } : ok({})));
    await assert.rejects(makeFrontDoorDrill(async () => new Response("", { status: 401 })).teardown(ctx));
    assert.equal(ctx.deps.fs.files.get("stack/front-door.auto.tfvars.json"), '{"front_door":false}\n');
    assert.ok(ctx.cliCalls.some((c) => c[0] === "deploy"));
  });
});
