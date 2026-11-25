import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeFallbackDrill } from "../src/drills/fallback.ts";
import { spotDrill } from "../src/drills/spot.ts";
import {
  after,
  instance,
  invocation,
  makeCtx,
  message,
  ok,
  play,
  reservations,
  router,
  servingStatus,
  ssmRoutes,
  type TestCtx,
} from "./d23-support.ts";

const SPOT_STEPS = ["wake", "hold", "notice", "reclaim", "request-open", "wake-again"];

/** A Spot box that stops itself once the notice proxy is installed; `because` is what its last-words say. */
function spotWorld(because: string, requestState = "disabled") {
  const world = { state: "stopped", scripts: [] as string[] };
  const ctx = makeCtx({
    cli: (argv) => {
      if (argv[0] === "wake") {
        world.state = "running";
        return ok(servingStatus("i-spot", "spot"));
      }
      if (argv[0] === "park") world.state = "stopped";
      return ok({});
    },
  });
  ctx.deps.awsCli.answer = router({
    "ec2 describe-instances": () => reservations([instance({ id: "i-spot", state: world.state, spot: true })]),
    "ec2 describe-spot-instance-requests": () => ({ SpotInstanceRequests: [{ State: requestState }] }),
    "ssm get-parameter": () => ({
      Parameter: {
        Value: JSON.stringify({
          parkedBecause: because,
          detail: "notice",
          at: new Date(ctx.deps.clock.now()).toISOString(),
        }),
      },
    }),
    ...ssmRoutes(
      world.scripts,
      (s) => (s.includes("PROXY_OK") ? "PROXY_OK\n" : ""),
      (s) => {
        if (s.includes("systemd-run")) world.state = "stopped";
      },
    ),
  });
  return { ctx, world };
}

describe("drill spot", () => {
  it("passes when the box parks as reclaim despite the hold, leaves the request open and wakes on Spot again", async () => {
    const { ctx, world } = spotWorld("reclaim");
    const r = await play(spotDrill, ctx);
    assert.equal(r.failure, null, message(r.failure));
    assert.equal(r.teardownError, null);
    assert.deepEqual(r.ran, SPOT_STEPS);
    const [hold, proxy] = world.scripts;
    assert.match(hold ?? "", /dozebox hold drill --payload marker --reason drill --for \dm/);
    assert.match(proxy ?? "", /169\.254\.169\.254/);
    assert.match(proxy ?? "", /DOZEBOX_IMDS_URL=http:\/\/127\.0\.0\.1:1338/);
    assert.match(proxy ?? "", /spot\/instance-action/);
    assert.equal(ctx.facts.get("spot.parkedBecause"), "reclaim");
    assert.equal(ctx.cliCalls.at(-1)?.[0], "park");
  });

  it("fails when the last words give another reason, and still parks", async () => {
    const { ctx, world } = spotWorld("idle");
    const r = await play(spotDrill, ctx);
    assert.deepEqual(r.ran, SPOT_STEPS.slice(0, 4));
    assert.match(message(r.failure), /idle/);
    assert.equal(ctx.cliCalls.at(-1)?.[0], "park");
    // The box is stopped by then; nothing to clean on it.
    assert.equal(world.scripts.filter((s) => s.includes("rm -f")).length, 0);
  });

  it("fails when the Spot request was cancelled", async () => {
    const { ctx } = spotWorld("reclaim", "cancelled");
    const r = await play(spotDrill, ctx);
    assert.equal(r.ran.at(-1), "request-open");
    assert.match(message(r.failure), /cancelled/);
  });

  it("removes the drop-in when the drill fails while the box still runs", async () => {
    const { ctx, world } = spotWorld("reclaim");
    // The hold fails: the box is still running when teardown starts.
    const base = ctx.deps.awsCli.answer;
    ctx.deps.awsCli.answer = (args) => {
      if (args[1] === "list-command-invocations" && world.scripts.length === 1) {
        return invocation("Failed", 1);
      }
      return base(args);
    };
    const r = await play(spotDrill, ctx);
    assert.equal(r.ran.at(-1), "hold");
    assert.ok(world.scripts.some((s) => s.includes("rm -f") && s.includes("drill-imds.conf")));
    assert.equal(ctx.cliCalls.at(-1)?.[0], "park");
  });
});

type FallbackOpts = { readonly saved?: unknown; readonly holder?: string; readonly groupStaysUp?: boolean };

/** The persistent Spot instance and the fallback group, with the control function's reaction to the planted error. */
function fallbackWorld(opts: FallbackOpts = {}) {
  const w = {
    persistent: "stopped",
    fb: "none" as "none" | "running",
    groupDesired: 0,
    item: opts.saved ?? null,
    puts: [] as string[],
    deleted: 0,
    delivered: [] as string[],
  };
  const ctx = makeCtx({
    cli: (argv) => {
      if (argv[0] === "wake" && !argv.includes("--wait")) {
        w.fb = "running";
        w.groupDesired = 1;
        return ok({ state: "launching" });
      }
      if (argv[0] === "wake") {
        w.persistent = "running";
        return ok(servingStatus("i-p", "spot"));
      }
      if (argv[0] === "status") return ok(servingStatus("i-fb", "on-demand", "fallback"));
      if (argv[0] === "park") {
        w.persistent = "stopped";
        w.fb = "none";
        if (opts.groupStaysUp !== true) w.groupDesired = 0;
      }
      return ok({});
    },
    options: { deliver: "agent.tgz" },
  });
  ctx.deps.awsCli.answer = router({
    "ec2 describe-instances": () =>
      reservations([
        instance({ id: "i-p", state: w.persistent, spot: true }),
        ...(w.fb === "running" ? [instance({ id: "i-fb", state: "running", group: "dozebox-main-od" })] : []),
      ]),
    "autoscaling describe-auto-scaling-groups": () => ({ AutoScalingGroups: [{ DesiredCapacity: w.groupDesired }] }),
    "autoscaling set-desired-capacity": () => {
      w.groupDesired = 0;
      return null;
    },
    "ec2 describe-volumes": () => ({
      Volumes: [
        {
          Attachments: [{ State: "attached", InstanceId: opts.holder ?? (w.fb === "running" ? "i-fb" : "i-p") }],
        },
      ],
    }),
    "dynamodb get-item": (args) =>
      after(args, "--key").includes("lease#")
        ? { Item: { fencing: { N: "7" } } }
        : w.item === null
          ? {}
          : { Item: w.item },
    "dynamodb put-item": (args) => {
      w.puts.push(after(args, "--item"));
      return null;
    },
    "dynamodb delete-item": () => {
      w.deleted++;
      return null;
    },
  });
  const drill = makeFallbackDrill(async (_ctx, id) => void w.delivered.push(id));
  return { ctx: ctx as TestCtx, w, drill };
}

const FALLBACK_STEPS = [
  "preflight",
  "plant-capacity-error",
  "wake-on-demand",
  "volume-moved",
  "restore-and-park",
  "wake-on-spot",
];

describe("drill fallback", () => {
  it("serves On-Demand through the fallback group, delivers the agent, then goes back to Spot", async () => {
    const { ctx, w, drill } = fallbackWorld();
    const r = await play(drill, ctx);
    assert.equal(r.failure, null, message(r.failure));
    assert.equal(r.teardownError, null);
    assert.deepEqual(r.ran, FALLBACK_STEPS);
    const planted = JSON.parse(w.puts[0] ?? "{}") as {
      value: { S: string };
      pk: { S: string };
      fencing: { N: string };
    };
    assert.equal(planted.pk.S, "kv#last-start-error");
    assert.equal(planted.fencing.N, "7");
    assert.equal((JSON.parse(planted.value.S) as { kind: string }).kind, "capacity");
    assert.deepEqual(w.delivered, ["i-fb"]);
    assert.equal(w.deleted, 1, "an item that did not exist is deleted again, once");
    assert.equal(w.groupDesired, 0);
  });

  it("does not deliver when no tarball was given", async () => {
    const { ctx, w, drill } = fallbackWorld();
    Object.assign(ctx.options, { deliver: null });
    const r = await play(drill, ctx);
    assert.equal(r.failure, null, message(r.failure));
    assert.deepEqual(w.delivered, []);
  });

  it("puts back the last-start-error item it found", async () => {
    const saved = { pk: { S: "kv#last-start-error" }, value: { S: '{"at":5,"kind":"other"}' }, fencing: { N: "3" } };
    const { ctx, w, drill } = fallbackWorld({ saved });
    const r = await play(drill, ctx);
    assert.equal(r.failure, null, message(r.failure));
    assert.equal(w.deleted, 0);
    assert.deepEqual(JSON.parse(w.puts.at(-1) ?? "{}"), saved);
  });

  it("restores the item, parks and lowers the group in teardown when a step fails", async () => {
    const { ctx, w, drill } = fallbackWorld({ holder: "i-p", groupStaysUp: true });
    const r = await play(drill, ctx);
    assert.equal(r.ran.at(-1), "volume-moved");
    assert.match(message(r.failure), /attached to i-p/);
    assert.equal(r.teardownError, null);
    assert.equal(w.deleted, 1);
    assert.equal(ctx.cliCalls.at(-1)?.[0], "park");
    assert.equal(w.groupDesired, 0, "teardown set the group back to 0 after the park left it up");
    assert.ok(ctx.deps.awsCli.calls.some((c) => c[1] === "set-desired-capacity"));
  });

  it("still parks and lowers the group when restoring the item fails", async () => {
    const { ctx, w, drill } = fallbackWorld({ holder: "i-p", groupStaysUp: true });
    const base = ctx.deps.awsCli.answer;
    ctx.deps.awsCli.answer = (args) => {
      if (args[1] === "delete-item") throw new Error("denied");
      return base(args);
    };
    const r = await play(drill, ctx);
    assert.match(message(r.teardownError), /denied/);
    assert.equal(ctx.cliCalls.at(-1)?.[0], "park");
    assert.equal(w.groupDesired, 0);
  });

  it("refuses to start when the box is not parked", async () => {
    const { ctx, w, drill } = fallbackWorld();
    w.persistent = "running";
    const r = await play(drill, ctx);
    assert.deepEqual(r.ran, ["preflight"]);
    assert.match(message(r.failure), /parked first/);
    assert.deepEqual(w.puts, [], "nothing was planted");
  });
});
