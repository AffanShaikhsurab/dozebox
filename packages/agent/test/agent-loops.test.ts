// agent-loops.ts through runAgent: payloads start once, the first healthy check serves (rec/serving, the old
// last-error and last-words deleted, the boot timeline published), and an idle box parks itself.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeFakeSupervisor } from "@dozebox/testkit/fakes";
import { makeAgentLoops, RUN_DIR } from "../src/agent-loops.ts";
import { runAgent, type Proc } from "../src/run.ts";
import { flush, harness } from "./support.ts";

const proc: Proc = { once: () => {}, exit: () => {} };

test("serve, then park on idle through the self-stop target", async () => {
  const h = harness();
  const sup = makeFakeSupervisor();
  sup.units = [{ name: "web", active: "inactive", activeSince: null, restarts: 0 }];
  sup.health = [{ name: "web", ok: true, detail: "HTTP 200" }];
  const stops: string[] = [];
  const deps = {
    ...h.deps,
    selfStop: {
      stopSelf: async (t: { mode: string; instanceId: string }) => void stops.push(`${t.mode}:${t.instanceId}`),
    },
  };
  const agent = await runAgent(deps, proc, { extra: makeAgentLoops({ supervisor: () => sup }) });
  await flush(200);
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

  // Health-only, no CPU in the cgroup: idle 30 minutes after serving.
  for (let i = 0; i < 70; i++) {
    h.clock.advance(30_000);
    await flush(200);
  }
  assert.deepEqual(stops, ["persistent:i-0123456789abcdef0"]);
  assert.equal(JSON.parse(h.records.get("rec/last-words") ?? "null").parkedBecause, "idle");
  assert.deepEqual(sup.calls, ["startAll", "stopAll"]);
  assert.equal(await h.files.readText(`${RUN_DIR}/phase`), "sleeping\n");
  await agent.loops.stop();
});
