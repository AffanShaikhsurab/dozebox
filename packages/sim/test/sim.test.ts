// The simulator as a suite (port of legacy sim.node-test.ts): the census on the per-PR seed count, open findings
// still real, determinism, and the invariants on hand-made actions.
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Control } from "../src/control/control.ts";
import { makeConfig } from "../src/config.ts";
import { createWorldInvariants } from "../src/invariants/world.ts";
import { ceilingFor, judgeCensus, knownClasses } from "../src/known.ts";
import { createRng } from "../src/prng.ts";
import { censusOf, runSeed } from "../src/run.ts";
import { describeFailure, simulate } from "../src/simulate.ts";
import { World } from "../src/world/world.ts";

const SEEDS = Number(process.env["SIM_SEEDS"] ?? 1000);

const bareWorld = () => {
  const rng = createRng(1);
  const w = new World(rng, makeConfig(rng.fork("config")));
  const control = new Control(w);
  return { w, inv: createWorldInvariants(w, control) };
};

describe("seeded simulator", () => {
  it("holds the invariants on every seed, open findings aside, each under its ceiling", () => {
    const runs = Array.from({ length: SEEDS }, (_, i) => runSeed(i + 1));
    const c = censusOf(runs);
    const verdict = judgeCensus(c, knownClasses());
    const bad = runs.find((r) => r.errors.length > 0 || r.findings.some((f) => f.cls === "unknown"));
    assert.ok(verdict.ok, `${JSON.stringify(verdict.over)}\n${bad ? describeFailure(simulate(bad.seed)) : ""}`);
  });

  it("keeps each open finding real: its seed still shows its class", () => {
    for (const k of knownClasses()) {
      const r = runSeed(k.seed);
      assert.ok(
        r.findings.some((f) => f.rule === k.name),
        `${k.id} (${k.name}) no longer reproduces on seed ${k.seed}: delete it from known.ts if fixed, or refresh the seed`,
      );
    }
  });
});

describe("simulator self-checks", () => {
  it("a seed replays exactly", () => {
    const a = simulate(7);
    const b = simulate(7);
    assert.deepEqual(a.trace, b.trace);
    assert.deepEqual(a.violations, b.violations);
  });

  it("a seed does not depend on the seeds run before it", () => {
    const alone = simulate(9);
    simulate(11);
    assert.deepEqual(simulate(9).trace, alone.trace);
  });

  it("random streams forked by label do not disturb each other", () => {
    const a = createRng(1);
    const b = createRng(1);
    a.fork("x").next();
    assert.equal(a.fork("y").next(), b.fork("y").next());
    assert.notEqual(createRng(1).next(), createRng(2).next());
  });

  it("the invariants name a dangerous action by the control function", () => {
    const { w, inv } = bareWorld();
    w.hooks.action({
      type: "detach",
      actor: "control",
      volumeId: "vol-1",
      instanceId: "i-1",
      instanceState: "running",
      startedAt: null,
    });
    w.hooks.action({ type: "stop", actor: "control", id: "i-1", holdsVolume: true });
    w.hooks.action({ type: "attach", actor: "agent", volumeId: "vol-1", instanceId: "i-1", active: false });
    assert.deepEqual(inv.violations.map((v) => v.rule).toSorted(), [
      "attach-stale-volume",
      "detach-running/unexplained",
      "stop-holder",
    ]);
  });

  it("a park stop is not a stop of the holder", () => {
    const { w, inv } = bareWorld();
    w.hooks.action({ type: "stop", actor: "control-park", id: "i-1", holdsVolume: true });
    assert.deepEqual(inv.violations, []);
  });

  it("the invariants name a recovery that parks and relaunches by itself", () => {
    const { w, inv } = bareWorld();
    w.hooks.action({ type: "setDesired", n: 0, actor: "control", groupHoldsVolume: false });
    w.hooks.action({ type: "setDesired", n: 1, actor: "control", groupHoldsVolume: false });
    assert.deepEqual(
      inv.violations.map((v) => v.rule),
      ["recovery-loop/other"],
    );
  });

  it("the judge fails an unknown class, a class over its ceiling and a model error", () => {
    const [k] = knownClasses();
    assert.ok(k !== undefined);
    const ok = judgeCensus(
      { seeds: 5000, byClass: { [k.name]: k.ceiling }, examples: {}, modelErrors: 0 },
      knownClasses(),
    );
    assert.deepEqual(ok, { ok: true, over: [] });
    const bad = judgeCensus(
      { seeds: 5000, byClass: { [k.name]: k.ceiling + 1, "two-billing/other": 1 }, examples: {}, modelErrors: 1 },
      knownClasses(),
    );
    assert.deepEqual(
      bad.over.map((o) => o.id),
      [`${k.id} ${k.name}`, "two-billing/other", "model-error"],
    );
  });

  it("the ceiling follows the census formula", () => {
    assert.equal(ceilingFor(0, 5000), 1);
    assert.equal(ceilingFor(36, 5000), Math.ceil(1.5 * 1.8 + 3 * Math.sqrt(1.8)) + 1);
  });
});
