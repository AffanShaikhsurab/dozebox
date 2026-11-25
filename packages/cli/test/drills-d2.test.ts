import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
function spotWorld(because: string, requestState = "disabled", activePolls = 0) {
  const world = { state: "stopped", scripts: [] as string[], activeLeft: activePolls, requestPolls: 0 };
  const ctx = makeCtx({
    cli: (argv) => {
      if (argv[0] === "wake") {
        world.state = "running";
        return ok({});
      }
      if (argv[0] === "status") return ok(world.state === "running" ? servingStatus("i-spot", "spot") : {});
      if (argv[0] === "park") world.state = "stopped";
      return ok({});
    },
  });
  ctx.deps.awsCli.answer = router({
    "ec2 describe-instances": () => reservations([instance({ id: "i-spot", state: world.state, spot: true })]),
    "ec2 describe-spot-instance-requests": () => {
      world.requestPolls += 1;
      // A stopped box whose Spot request still says active: a wake now would be sent to the fallback.
      if (world.state === "stopped" && world.activeLeft > 0) {
        world.activeLeft -= 1;
        return { SpotInstanceRequests: [{ State: "active" }] };
      }
      return { SpotInstanceRequests: [{ State: requestState }] };
    },
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

  it("does not wake until the Spot request has finished stopping", async () => {
    const { ctx, world } = spotWorld("reclaim", "disabled", 3);
    const r = await play(spotDrill, ctx);
    assert.equal(r.failure, null, message(r.failure));
    assert.equal(world.activeLeft, 0);
    assert.ok(world.requestPolls >= 4);
    assert.equal(ctx.cliCalls.find((c) => c[0] === "wake")?.length, 1);
  });

  it("pushes the agent to the instance the wake starts when --deliver is set", async () => {
    const { ctx, world } = spotWorld("reclaim");
    const dir = mkdtempSync(join(tmpdir(), "dz-spot-"));
    const tarball = join(dir, "dozebox-agent-0.0.1-linux-aarch64.tar.gz");
    writeFileSync(tarball, "x");
    Object.assign(ctx.options, { deliver: tarball });
    try {
      const r = await play(spotDrill, ctx);
      assert.equal(r.failure, null, message(r.failure));
      assert.ok(world.scripts.some((s) => s.includes("install-agent.sh")));
      assert.equal(ctx.facts.get("delivered"), "0.0.1");
    } finally {
      rmSync(dir, { recursive: true });
    }
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
    fbWoken: false,
  };
  const ctx = makeCtx({
    cli: (argv) => {
      if (argv[0] === "wake" && !w.fbWoken) {
        // The first wake meets the planted capacity error and goes to the group; the later one starts the Spot box.
        w.fbWoken = true;
        w.fb = "running";
        w.groupDesired = 1;
        return ok({ state: "launching" });
      }
      if (argv[0] === "wake") {
        w.persistent = "running";
        return ok({});
      }
      if (argv[0] === "status") {
        return ok(w.fb === "running" ? servingStatus("i-fb", "on-demand", "fallback") : servingStatus("i-p", "spot"));
      }
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
    // The Spot box has never run before this drill, so it gets the agent too.
    assert.deepEqual(w.delivered, ["i-fb", "i-p"]);
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
