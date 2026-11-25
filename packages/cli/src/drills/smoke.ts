// D1: `dozebox drill smoke`, part 10 §10.1.2. Steps 1 to 11 and 13; 12 (control upgrade and rollback) is skippable
// with `--skip upgrade`. `--with-hold` adds the hold step (phase 4). `--keep` parks the stack at the end instead of
// destroying it (the warm stack the other drills reuse).
import { DozeboxCliError } from "../command.ts";
import { arr, aws, cliOk, obj, runningInstance, shell, str } from "./box.ts";
import { controlStatus, parkForce, waitParked, wakeToServing, type Status } from "./flow.ts";
import { smokeExtras } from "./smoke-extras.ts";
import type { Drill, DrillContext, DrillStep } from "./types.ts";

const MIN = 60_000;

async function nonceOnBox(ctx: DrillContext, signal: AbortSignal): Promise<void> {
  const i = await runningInstance(ctx, signal);
  const out = await shell(ctx, i.id, "cat /data/payloads/marker/nonce", signal);
  if (out.stdout.trim() !== ctx.nonce) {
    throw new DozeboxCliError("problem", `nonce on ${i.id} is "${out.stdout.trim()}", want "${ctx.nonce}"`);
  }
}

function expectReason(lw: Status, want: string): void {
  if (lw["parkedBecause"] !== want) {
    throw new DozeboxCliError("problem", `rec/last-words says ${String(lw["parkedBecause"])}, want ${want}`);
  }
}

/** Step 6: AttachVolume of a volume without the box's tags, signed with the box role's IMDS credentials. */
function attachProbeScript(region: string, volumeId: string): string {
  return [
    "set -eu",
    "imds=http://169.254.169.254/latest",
    'tok=$(curl -fsS -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" $imds/api/token)',
    'h="X-aws-ec2-metadata-token: $tok"',
    'iid=$(curl -fsS -H "$h" $imds/meta-data/instance-id)',
    'role=$(curl -fsS -H "$h" $imds/meta-data/iam/security-credentials/)',
    'c=$(curl -fsS -H "$h" $imds/meta-data/iam/security-credentials/$role)',
    'j() { printf \'%s\' "$c" | sed -n "s/.*\\"$1\\" *: *\\"\\([^\\"]*\\)\\".*/\\1/p"; }',
    `curl -sS --aws-sigv4 "aws:amz:${region}:ec2" --user "$(j AccessKeyId):$(j SecretAccessKey)" \\`,
    '  -H "x-amz-security-token: $(j Token)" \\',
    `  "https://ec2.${region}.amazonaws.com/?Action=AttachVolume&Version=2016-11-15&VolumeId=${volumeId}&InstanceId=$iid&Device=/dev/sdz"`,
  ].join("\n");
}

const steps: ReadonlyArray<DrillStep> = [
  {
    id: "deploy",
    deadlineMs: 10 * MIN,
    run: async (ctx, signal) => {
      const out = await cliOk(ctx, ["deploy"], signal);
      ctx.facts.set("deployChanged", out["changed"] === true);
    },
  },
  {
    id: "doctor",
    deadlineMs: MIN,
    run: async (ctx, signal) => {
      const r = await ctx.cli(["doctor"], signal);
      const failed = arr(obj(r.json)["checks"])
        .map(obj)
        .filter((c) => c["ok"] !== true && c["status"] !== "ok");
      ctx.facts.set("doctorFailed", failed);
      if (r.code !== 0) throw new DozeboxCliError("problem", `doctor: ${JSON.stringify(failed).slice(0, 600)}`);
    },
  },
  {
    id: "starts-parked",
    deadlineMs: 10 * MIN,
    run: async (ctx, signal) => void (await waitParked(ctx, signal)),
  },
  {
    id: "wake",
    deadlineMs: 15 * MIN,
    run: async (ctx, signal) => {
      const s = await wakeToServing(ctx, signal);
      if (s["state"] !== "running") throw new DozeboxCliError("problem", `state ${String(s["state"])}, want running`);
      // The persistent instance serves (Spot or On-Demand per instance.purchase; drills run On-Demand), not the fallback.
      if (s["machine"] !== undefined && s["machine"] !== "persistent") {
        throw new DozeboxCliError("problem", `machine ${String(s["machine"])}, want persistent`);
      }
    },
  },
  { id: "payload-serves", deadlineMs: 2 * MIN, run: nonceOnBox },
  {
    id: "attach-fence",
    deadlineMs: 3 * MIN,
    run: async (ctx, signal) => {
      const s = await ctx.stack();
      const i = await runningInstance(ctx, signal);
      const test = { Key: "dozebox:test", Value: s.boxId };
      const made = await aws(
        ctx,
        [
          "ec2",
          "create-volume",
          "--availability-zone",
          i.zone,
          "--size",
          "1",
          "--volume-type",
          "gp3",
          "--tag-specifications",
          JSON.stringify([{ ResourceType: "volume", Tags: [test, { Key: "dozebox:owner", Value: "orchestrator" }] }]),
        ],
        signal,
      );
      const vol = str(made["VolumeId"]) ?? "";
      ctx.facts.set("fenceVolume", vol);
      try {
        await aws(ctx, ["ec2", "wait", "volume-available", "--volume-ids", vol], signal);
        const out = await shell(ctx, i.id, attachProbeScript(s.region, vol), signal, { check: false });
        if (!/UnauthorizedOperation|AccessDenied/.test(out.stdout + out.stderr)) {
          throw new DozeboxCliError("problem", `AttachVolume was not refused: ${out.stdout.slice(0, 400)}`);
        }
      } finally {
        await aws(ctx, ["ec2", "delete-volume", "--volume-id", vol]).catch((e: unknown) =>
          ctx.log(`could not delete ${vol}: ${String(e)}`),
        );
      }
    },
  },
  {
    id: "park-by-user",
    deadlineMs: 5 * MIN,
    run: async (ctx, signal) => {
      const i = await runningInstance(ctx, signal);
      expectReason(await parkForce(ctx, signal, "user"), "user");
      const req = await aws(
        ctx,
        ["ec2", "describe-spot-instance-requests", "--filters", `Name=instance-id,Values=${i.id}`],
        signal,
      );
      const requests = arr(req["SpotInstanceRequests"]);
      const state = str(obj(requests[0])["State"]);
      ctx.facts.set("spotRequest", state ?? "none (on-demand)");
      if (requests.length > 0 && state !== "disabled") throw new DozeboxCliError("problem", `Spot request ${String(state)}, want disabled`);
    },
  },
  {
    id: "hold",
    deadlineMs: 25 * MIN,
    when: (o) => o.withHold,
    run: async (ctx, signal) => {
      await wakeToServing(ctx, signal);
      const i = await runningInstance(ctx, signal);
      const bin = "/opt/dozebox/current/bin/dozebox";
      await shell(ctx, i.id, `${bin} hold drill --payload marker --reason drill --for 15m`, signal);
      await ctx.deps.clock.sleep(8 * MIN, signal); // idle_minutes 5 + 2 with the hold live
      const still = await runningInstance(ctx, signal).catch(() => null);
      if (still === null) throw new DozeboxCliError("problem", "the box parked while a hold was live");
      await shell(ctx, i.id, `${bin} hold drill --payload marker --release`, signal);
      const released = ctx.deps.clock.now();
      expectReason(await waitParked(ctx, signal), "idle");
      const took = ctx.deps.clock.now() - released;
      ctx.facts.set("parkAfterReleaseMs", took);
      if (took > 7 * MIN) throw new DozeboxCliError("problem", `parked ${Math.round(took / 1000)} s after release`);
    },
  },
  {
    id: "idle-park",
    deadlineMs: 15 * MIN,
    run: async (ctx, signal) => {
      await wakeToServing(ctx, signal);
      const served = ctx.deps.clock.now();
      expectReason(await waitParked(ctx, signal), "idle");
      ctx.facts.set("idleParkMs", ctx.deps.clock.now() - served);
    },
  },
  {
    id: "snapshot",
    deadlineMs: 10 * MIN,
    run: async (ctx, signal) => {
      const out = await cliOk(ctx, ["snapshots", "create", "--label", ctx.runId], signal);
      if (out["completed"] !== true) throw new DozeboxCliError("problem", "snapshot did not complete");
      ctx.facts.set("snapshot", out["snapshotId"]);
    },
  },
  {
    id: "restore",
    deadlineMs: 10 * MIN,
    run: async (ctx, signal) => {
      const out = await cliOk(ctx, ["restore", "latest"], signal);
      ctx.facts.set("restored", out);
      const vols = arr(obj(await cliOk(ctx, ["volumes", "list"], signal))["volumes"]).map(obj);
      const active = vols.filter((v) => v["active"] === true);
      if (active.length !== 1 || active[0]?.["id"] !== out["volumeId"]) {
        throw new DozeboxCliError("problem", `active volumes ${JSON.stringify(active.map((v) => v["id"]))}`);
      }
      const old = vols.find((v) => v["id"] === out["retired"]);
      if (out["retired"] !== null && old?.["retired"] !== true)
        throw new DozeboxCliError("problem", "old volume not retired");
    },
  },
  {
    id: "wake-restored",
    deadlineMs: 15 * MIN,
    run: async (ctx, signal) => {
      await wakeToServing(ctx, signal);
      await nonceOnBox(ctx, signal);
    },
  },
  ...smokeExtras,
];

export const smokeDrill: Drill = {
  name: "smoke",
  // About 45 min of a t4g Spot box at most (on-demand price as the ceiling), volumes, a snapshot, Run Command.
  estimateUsd: async () => 0.1,
  steps,
  teardown: async (ctx) => {
    const signal = ctx.deps.clock.timeout(20 * MIN);
    const s = await controlStatus(ctx, signal).catch(() => null);
    if (s !== null && s["state"] !== "parked") await parkForce(ctx, signal);
    if (ctx.options.keep) return;
    await cliOk(ctx, ["destroy"], signal);
  },
};
