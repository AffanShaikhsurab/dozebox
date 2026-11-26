// agent-loops.ts through runAgent: payloads start once, the first healthy check serves (rec/serving, the old
// last-error and last-words deleted, the boot timeline published), an idle box parks itself, a person's sleep request
// parks with reason user, and a Spot notice parks with reason reclaim. The A2/A6 services are fakes here; their own
// tests cover them.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeFakeExec, makeFakeHostStats, makeFakeSpotNotices, makeFakeSupervisor } from "@dozebox/testkit/fakes";
import { makeAgent, RUN_DIR, type AgentOptions } from "../src/agent-loops.ts";
import { APPARMOR_PROFILE, type JailReadiness } from "../src/jail/index.ts";
import type { ProtocolServerDeps } from "../src/protocol/index.ts";
import { runAgent, type Proc } from "../src/run.ts";
import { boxConfig, flush, harness } from "./support.ts";

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

// Bug 3: readiness was a snapshot taken before setupHost wrote the profile, the nft table and the tripwire units, so
// a fresh box (and every wake) reported ready:false for its whole life. The host state here is the real one: the
// profile is a file, the table and the socket are kernel state that a stop/start loses.
async function setupJail(over: { readonly throwOnProfile?: () => boolean } = {}) {
  const h = harness({ files: { "/etc/passwd": "web:x:1000:1000::/data/home/web:/bin/bash\n" } });
  h.params.set(
    "config",
    JSON.stringify(
      boxConfig({ jail: { enabled: true, egress: "imds-only", allowHosts: [] }, tripwire: { enabled: true } }),
    ),
  );
  const sup = makeFakeSupervisor();
  sup.units = [{ name: "web", active: "inactive", activeSince: null, restarts: 0 }];
  sup.health = [{ name: "web", ok: true, detail: "HTTP 200" }];
  const host = { nft: false, tripwire: false };
  const exec = makeFakeExec([
    { match: ["/usr/bin/bwrap", "--version"], outcome: { code: 0 } },
    { match: ["nft", "list", "table", "inet", "dozebox_egress"], outcome: () => ({ code: host.nft ? 0 : 1 }) },
    {
      match: ["nft", "-f", "/etc/dozebox/egress.nft"],
      outcome: () => {
        host.nft = true;
        return { code: 0 };
      },
    },
    {
      match: ["systemctl", "is-active", "--quiet", "dozebox-tripwire.socket"],
      outcome: () => ({ code: host.tripwire ? 0 : 3 }),
    },
    {
      match: ["systemctl", "enable", "--now", "dozebox-tripwire.socket"],
      outcome: () => {
        host.tripwire = true;
        return { code: 0 };
      },
    },
    { match: ["systemctl", "daemon-reload"], outcome: { code: 0 } },
    { match: ["apparmor_parser", "-r", APPARMOR_PROFILE], outcome: { code: 0 } },
    { match: ["visudo", "-cf", "/etc/sudoers.d/dozebox"], outcome: { code: 0 } },
  ]);
  const stats = makeFakeHostStats();
  stats.reachable = new Set(["ssm.amazonaws.com"]);
  let server: ProtocolServerDeps | null = null;
  const opts: AgentOptions = {
    supervisor: () => sup,
    server: (d) => {
      server = d;
      return { start: async () => {}, stop: async () => {}, publish: () => {} };
    },
    spotNotices: makeFakeSpotNotices(),
    hostStats: stats,
    journal: async (cursor) => ({ events: [], cursor }),
  };
  const files = {
    ...h.deps.files,
    readText: async (path: string) => {
      if (path === APPARMOR_PROFILE && over.throwOnProfile?.() === true)
        throw new Error("EIO: cannot read the profile");
      return h.deps.files.readText(path);
    },
  };
  const deps = { ...h.deps, exec, files, selfStop: { stopSelf: async () => {} } };
  const start = async () => {
    // Snapshot after makeAgent (setupHost has run) and before any loop tick (the egress table is not loaded yet).
    let beforeEgress: JailReadiness | null = null;
    const prepare = makeAgent(opts);
    const agent = await runAgent(deps, proc, {
      prepare: async (d, c) => {
        const prepared = await prepare(d, c);
        beforeEgress = server?.status("web").jail ?? null;
        return prepared;
      },
    });
    await flush(300);
    if (!server) throw new Error("no server");
    return { agent, srv: server as ProtocolServerDeps, beforeEgress };
  };
  return { h, host, exec, start };
}

test("jail readiness is not ready before the egress table lands, then flips to true", async () => {
  const { start } = await setupJail();
  const { agent, srv, beforeEgress } = await start();
  assert.deepEqual(beforeEgress, { ready: false, egress: "imds-only", missing: ["nftables"] });
  assert.deepEqual(srv.status("web").jail, { ready: true, egress: "imds-only", missing: [] });
  await agent.loops.stop();
});

test("a readiness check that throws reports not ready instead of keeping the last good fact", async () => {
  let fail = false;
  const { h, start } = await setupJail({ throwOnProfile: () => fail });
  const { agent, srv } = await start();
  assert.equal(srv.status("web").jail.ready, true);
  fail = true;
  h.clock.advance(30_000);
  await flush(300);
  const jail = srv.status("web").jail;
  assert.equal(jail.ready, false);
  assert.match(jail.missing.join(" "), /EIO: cannot read the profile/);
  await agent.loops.stop();
});

test("a wake re-runs setupHost and readiness", async () => {
  const { host, exec, start } = await setupJail();
  const first = await start();
  assert.equal(first.srv.status("web").jail.ready, true);
  await first.agent.loops.stop();
  // A stop/start keeps the disk (the profile) and loses the kernel state (the table and the socket).
  host.nft = false;
  host.tripwire = false;
  const second = await start();
  assert.deepEqual(second.srv.status("web").jail, { ready: true, egress: "imds-only", missing: [] });
  assert.equal(exec.of("apparmor_parser").length, 2);
  assert.equal(exec.of("systemctl").filter((c) => c.argv.includes("enable")).length, 2);
  await second.agent.loops.stop();
});
