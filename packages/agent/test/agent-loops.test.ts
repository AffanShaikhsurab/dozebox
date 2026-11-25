// agent-loops.ts through runAgent: payloads start once, the first healthy check serves (rec/serving, the old
// last-error and last-words deleted, the boot timeline published), an idle box parks itself, a person's sleep request
// parks with reason user, and a Spot notice parks with reason reclaim. The A2/A6 services are fakes here; their own
// tests cover them.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeFakeHostStats, makeFakeSpotNotices, makeFakeSupervisor } from "@dozebox/testkit/fakes";
import { makeAgent, RUN_DIR, type AgentOptions } from "../src/agent-loops.ts";
import type { ProtocolServerDeps } from "../src/protocol/index.ts";
import { runAgent, type Proc } from "../src/run.ts";
import { flush, harness } from "./support.ts";

const proc: Proc = { once: () => {}, exit: () => {} };

async function setup() {
  const h = harness();
  const sup = makeFakeSupervisor();
  sup.units = [{ name: "web", active: "inactive", activeSince: null, restarts: 0 }];
  sup.health = [{ name: "web", ok: true, detail: "HTTP 200" }];
  const stops: string[] = [];
  const events: string[] = [];
  const spot = makeFakeSpotNotices();
  const stats = makeFakeHostStats();
  stats.reachable = new Set(["ssm.amazonaws.com"]);
  let server: ProtocolServerDeps | null = null;
  const opts: AgentOptions = {
    supervisor: () => sup,
    server: (d) => {
      server = d;
      return { start: async () => {}, stop: async () => {}, publish: (name) => void events.push(name) };
    },
    spotNotices: spot,
    hostStats: stats,
    journal: async (cursor) => ({ events: [], cursor }),
    jail: async () => ({ ready: false, egress: "off", missing: ["jail"] }),
  };
  const deps = {
    ...h.deps,
    selfStop: {
      stopSelf: async (t: { mode: string; instanceId: string }) => void stops.push(`${t.mode}:${t.instanceId}`),
    },
  };
  const agent = await runAgent(deps, proc, { prepare: makeAgent(opts) });
  await flush(300);
  const srv = (): ProtocolServerDeps => {
    if (!server) throw new Error("no server");
    return server;
  };
  return { h, sup, stops, events, spot, agent, srv };
}

const run = async (h: ReturnType<typeof harness>, steps: number) => {
  for (let i = 0; i < steps; i++) {
    h.clock.advance(30_000);
    await flush(300);
  }
};

test("serve, then park on idle through the self-stop target", async () => {
  const { h, sup, stops, events, agent, srv } = await setup();
  assert.deepEqual(sup.calls, ["startAll"]);
  const order = h.events.filter((e) => /rec\/(serving|last-error|last-words|boot-timeline)/.test(e));
  assert.deepEqual(order, [
    "put:rec/serving",
    "delete:rec/last-error",
    "delete:rec/last-words",
    "put:rec/boot-timeline",
  ]);
  assert.equal(JSON.parse(h.records.get("rec/serving") ?? "null").payload, "web");
  assert.equal(await h.files.readText(`${RUN_DIR}/phase`), "serving\n");
  const steps = JSON.parse(h.records.get("rec/boot-timeline") ?? "null").steps.map((s: { step: string }) => s.step);
  assert.deepEqual(steps, ["payload-start", "serving"]);
  const status = srv().status("web");
  assert.equal(status.box.phase, "serving");
  assert.equal(status.box.id, "box-1");

  // Health-only, no CPU in the cgroup: idle 30 minutes after serving.
  await run(h, 70);
  assert.ok(h.records.has("rec/liveness"));
  assert.deepEqual(stops, ["persistent:i-0123456789abcdef0"]);
  assert.equal(JSON.parse(h.records.get("rec/last-words") ?? "null").parkedBecause, "idle");
  assert.deepEqual(sup.calls, ["startAll", "stopAll"]);
  assert.equal(await h.files.readText(`${RUN_DIR}/phase`), "sleeping\n");
  assert.ok(events.includes("sleeping"));
  assert.deepEqual(await srv().sleep(false), { accepted: false, blockers: ["parking"] });
  await agent.loops.stop();
});

test("a person's sleep request parks with reason user; a hold blocks it unless forced", async () => {
  const { h, stops, agent, srv } = await setup();
  await run(h, 1);
  assert.deepEqual(await srv().sleep(false), { accepted: true, blockers: [] });
  await flush(300);
  assert.equal(JSON.parse(h.records.get("rec/last-words") ?? "null").parkedBecause, "user");
  assert.equal(stops.length, 1);
  await agent.loops.stop();
});

test("a Spot notice moves to reclaim-notice and parks with reason reclaim", async () => {
  const { h, spot, stops, agent } = await setup();
  spot.notice = { action: "stop", at: h.clock.now() + 120_000 };
  await run(h, 4);
  assert.equal(JSON.parse(h.records.get("rec/last-words") ?? "null").parkedBecause, "reclaim");
  assert.equal(stops.length, 1);
  await agent.loops.stop();
});
