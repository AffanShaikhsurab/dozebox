import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { controlStatusFixture, makeFakeCliDeps, stackOutputsFixture } from "@dozebox/testkit/fakes";
import { RECONCILE_EVENT, directTick } from "../src/drills/tick.ts";
import { parkAndWait } from "../src/drills/parked.ts";
import type { DrillContext } from "../src/drills/types.ts";
import { stackFromOutputs } from "../src/stack.ts";

function context() {
  const deps = makeFakeCliDeps({ status: controlStatusFixture(), outputs: stackOutputsFixture() });
  const stack = stackFromOutputs("stack", stackOutputsFixture());
  const lines: string[] = [];
  const ctx: DrillContext = {
    runId: "tick-1",
    stackDir: "stack",
    nonce: "n",
    log: (l) => lines.push(l),
    stack: async () => stack,
    deps,
    options: { withHold: false, extras: [], keep: false, deliver: null, broken: null },
    facts: new Map(),
    cli: async () => ({ code: 0, json: {}, out: [] }),
  };
  return { ctx, deps, lines, stack };
}

describe("direct tick", () => {
  test("invokes alias live of the control function with the Scheduler's payload", async () => {
    const { ctx, deps, stack } = context();
    await directTick(ctx, new AbortController().signal);
    const call = deps.awsCli.calls.find((c) => c[0] === "lambda" && c[1] === "invoke") ?? [];
    assert.equal(call[call.indexOf("--function-name") + 1], `${stack.controlFunctionName}:live`);
    assert.equal(call[call.indexOf("--payload") + 1], RECONCILE_EVENT);
    assert.deepEqual(JSON.parse(RECONCILE_EVENT), { dozebox: "reconcile", v: 1 });
  });

  test("a failed invoke is logged and does not fail the drill; an abort still does", async () => {
    const { ctx, deps, lines } = context();
    deps.awsCli.answer = () => {
      throw new Error("AccessDenied");
    };
    await directTick(ctx, new AbortController().signal);
    assert.match(lines.join("\n"), /could not invoke .*:live: AccessDenied/);
    const stop = new AbortController();
    stop.abort(new Error("deadline"));
    await assert.rejects(directTick(ctx, stop.signal), /deadline/);
  });

  test("a park ticks once the park command went out", async () => {
    const { ctx, deps } = context();
    deps.awsCli.answer = (args) => (args[0] === "ec2" ? { Reservations: [] } : null);
    await parkAndWait(ctx, new AbortController().signal);
    assert.equal(deps.awsCli.calls.filter((c) => c[0] === "lambda" && c[1] === "invoke").length, 1);
  });
});
