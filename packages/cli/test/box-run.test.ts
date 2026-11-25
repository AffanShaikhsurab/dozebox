import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DozeboxCliError, EXIT, type CommandContext } from "../src/command.ts";
import { boxRun } from "../src/commands/box/run.ts";
import type { Exec } from "../src/ports/exec.ts";
import { setup } from "./box-support.ts";

type Run = Parameters<Exec["run"]>;

function withExec(t: ReturnType<typeof setup>, run: Exec["run"]): CommandContext {
  return { ...t.ctx, deps: { ...t.ctx.deps, exec: { run } } };
}

describe("box run", () => {
  it("holds while the command runs, releases after, and beats on output", async () => {
    const t = setup();
    let heldDuring: unknown;
    const ctx = withExec(t, async (_argv: Run[0], opts: Run[1]) => {
      heldDuring = t.client.kept.get("run-make");
      opts.onOutput("compiling");
      return { exitCode: 0, signal: null };
    });
    const r = await boxRun.run(ctx, { reason: "building" }, ["/usr/bin/make", "all"]);
    assert.deepEqual(heldDuring, { reason: "building", forSeconds: 600, renewEverySeconds: 120, kind: "work" });
    assert.equal(t.client.kept.size, 0);
    assert.deepEqual(t.client.beats, [{ kind: "progress", name: "run" }]);
    assert.deepEqual(t.client.attentions, []);
    assert.deepEqual(r, { exitCode: EXIT.ok, json: { exitCode: 0 } });
  });

  it("--hold-id names the hold", async () => {
    const t = setup();
    let seen = false;
    const ctx = withExec(t, async () => {
      seen = t.client.kept.has("my-job");
      return { exitCode: 0, signal: null };
    });
    await boxRun.run(ctx, { "hold-id": "my-job" }, ["x"]);
    assert.ok(seen);
  });

  it("throttles beats to one per 30 s", async () => {
    const t = setup();
    const ctx = withExec(t, async (_argv, opts) => {
      opts.onOutput("a");
      opts.onOutput("b");
      t.clock.advance(29_000);
      opts.onOutput("c");
      t.clock.advance(1_000);
      opts.onOutput("d");
      opts.onOutput("e");
      return { exitCode: 0, signal: null };
    });
    await boxRun.run(ctx, {}, ["x"]);
    assert.equal(t.client.beats.length, 2);
  });

  it("a failing command alerts once, exits 1 and reports the child's code", async () => {
    const t = setup();
    const ctx = withExec(t, async () => ({ exitCode: 7, signal: null }));
    const r = await boxRun.run(ctx, {}, ["npm", "test"]);
    assert.deepEqual(r, { exitCode: EXIT.problem, json: { exitCode: 7 } });
    assert.deepEqual(t.client.attentions, [
      { key: "run-failed:run-npm", severity: "notify", title: "run-npm failed", body: "exit 7" },
    ]);
    assert.equal(t.client.kept.size, 0);
  });

  it("--no-attention suppresses the alert", async () => {
    const t = setup();
    const ctx = withExec(t, async () => ({ exitCode: 2, signal: null }));
    const r = await boxRun.run(ctx, { "no-attention": true }, ["x"]);
    assert.equal(r.exitCode, EXIT.problem);
    assert.deepEqual(t.client.attentions, []);
  });

  it("releases the hold when the command cannot start", async () => {
    const t = setup();
    const ctx = withExec(t, async () => {
      throw new Error("spawn failed");
    });
    await assert.rejects(boxRun.run(ctx, {}, ["nope"]), /spawn failed/);
    assert.equal(t.client.kept.size, 0);
  });

  it("without a command is a usage error", async () => {
    await assert.rejects(
      setup().run(boxRun, {}, []),
      (e: unknown) => e instanceof DozeboxCliError && e.code === "usage",
    );
  });
});
