import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DozeboxCliError, EXIT } from "../src/command.ts";
import { BOX_COMMANDS } from "../src/commands/box/index.ts";
import { boxAttention } from "../src/commands/box/attention.ts";
import { boxBeat } from "../src/commands/box/beat.ts";
import { boxHold } from "../src/commands/box/hold.ts";
import { boxPresence } from "../src/commands/box/presence.ts";
import { boxSleep } from "../src/commands/box/sleep.ts";
import { boxStatus } from "../src/commands/box/status.ts";
import { boxWake } from "../src/commands/box/wake.ts";
import { NOW, setup, statusFixture } from "./box-support.ts";

const usage = (e: unknown): boolean => e instanceof DozeboxCliError && e.code === "usage";

const calls = (t: ReturnType<typeof setup>) => {
  const seen: unknown[] = [];
  Object.assign(t.client, { presence: async (...a: unknown[]) => void seen.push(a) });
  return seen;
};

describe("box commands", () => {
  it("are all box mode, in table order, and only status is read-only", () => {
    assert.deepEqual(
      BOX_COMMANDS.map((c) => c.name),
      ["status", "hold", "beat", "wake", "presence", "attention", "run", "sleep"],
    );
    assert.ok(BOX_COMMANDS.every((c) => c.mode === "box"));
    assert.deepEqual(
      BOX_COMMANDS.filter((c) => !c.mutates).map((c) => c.name),
      ["status"],
    );
  });

  it("every command needs the agent socket", async () => {
    const t = setup({ agent: false });
    for (const [cmd, pos] of [
      [boxStatus, []],
      [boxHold, ["x"]],
      [boxBeat, ["x"]],
      [boxWake, ["x"]],
      [boxPresence, ["x"]],
      [boxAttention, ["x"]],
      [boxSleep, []],
    ] as const) {
      await assert.rejects(
        t.run(cmd, {}, pos),
        (e: unknown) => e instanceof DozeboxCliError && e.code === "not-set-up" && /not on a box/.test(e.message),
      );
    }
  });

  it("status returns the document", async () => {
    const t = setup();
    const r = await t.run(boxStatus, {});
    assert.equal(r.exitCode, EXIT.ok);
    assert.deepEqual(r.json, statusFixture);
    assert.match(t.lines.join("\n"), /main: serving/);
  });

  it("status --json prints no human lines", async () => {
    const t = setup();
    await t.run(boxStatus, { json: true });
    assert.deepEqual(t.lines, []);
  });

  describe("hold", () => {
    it("--for holds until now + duration", async () => {
      const t = setup();
      const r = await t.run(boxHold, { for: "1h30m", reason: "build", kind: "wait" }, ["b1"]);
      assert.equal(r.exitCode, EXIT.ok);
      assert.deepEqual(t.client.holds.get("b1"), { reason: "build", until: "2026-11-25T01:30:00.000Z", kind: "wait" });
    });

    it("--until passes the instant and defaults the reason", async () => {
      const t = setup();
      await t.run(boxHold, { until: "2026-11-25T05:00:00Z" }, ["b1"]);
      assert.deepEqual(t.client.holds.get("b1"), { reason: "dozebox hold", until: "2026-11-25T05:00:00.000Z" });
    });

    it("--release releases", async () => {
      const t = setup();
      await t.run(boxHold, { for: "5m" }, ["b1"]);
      const r = await t.run(boxHold, { release: true }, ["b1"]);
      assert.equal(t.client.holds.has("b1"), false);
      assert.deepEqual(r.json, { id: "b1", released: true });
    });

    for (const [name, args, pos] of [
      ["both --until and --for", { until: NOW, for: "5m" }, ["b1"]],
      ["neither", {}, ["b1"]],
      ["bad kind", { for: "5m", kind: "x" }, ["b1"]],
      ["bad duration", { for: "soon" }, ["b1"]],
      ["bad instant", { until: "tomorrow-ish" }, ["b1"]],
      ["release with --for", { release: true, for: "5m" }, ["b1"]],
      ["no id", { for: "5m" }, []],
    ] as const) {
      it(`usage error: ${name}`, async () => {
        const t = setup();
        await assert.rejects(t.run(boxHold, args, pos), usage);
        assert.equal(t.client.holds.size, 0);
      });
    }
  });

  describe("beat", () => {
    it("sends one progress beat", async () => {
      const t = setup();
      const r = await t.run(boxBeat, {}, ["build"]);
      assert.deepEqual(t.client.beats, [{ kind: "progress", name: "build" }]);
      assert.equal(r.exitCode, EXIT.ok);
    });

    it("--every without --loop is a usage error", async () => {
      await assert.rejects(setup().run(boxBeat, { every: "10s" }, ["build"]), usage);
    });

    it("--loop beats every --every until the signal aborts, then exits 0", async () => {
      const t = setup();
      const slept: number[] = [];
      const clock = {
        ...t.clock,
        sleep: async (ms: number) => {
          slept.push(ms);
          if (slept.length === 3) t.abort.abort();
        },
      };
      const ctx = { ...t.ctx, deps: { ...t.ctx.deps, clock } };
      const r = await boxBeat.run(ctx, { loop: true, every: "30s" }, ["loop-a"]);
      assert.equal(r.exitCode, EXIT.ok);
      assert.deepEqual(slept, [30_000, 30_000, 30_000]);
      assert.equal(t.client.beats.length, 3);
      assert.ok(t.client.beats.every((b) => b.kind === "loop" && b.name === "loop-a"));
    });

    it("--loop sleeps 60s by default and stops when the sleep is aborted", async () => {
      const t = setup();
      const slept: number[] = [];
      const clock = {
        ...t.clock,
        sleep: async (ms: number, signal?: AbortSignal) => {
          slept.push(ms);
          t.abort.abort();
          throw signal?.reason;
        },
      };
      const ctx = { ...t.ctx, deps: { ...t.ctx.deps, clock } };
      const r = await boxBeat.run(ctx, { loop: true }, ["loop-a"]);
      assert.equal(r.exitCode, EXIT.ok);
      assert.deepEqual(slept, [60_000]);
    });
  });

  describe("wake", () => {
    it("--at sets a timed wake", async () => {
      const t = setup();
      await t.run(boxWake, { at: "2026-11-25T02:00:00Z", reason: "nightly" }, ["w1"]);
      assert.deepEqual(t.client.wakes.get("w1"), { reason: "nightly", at: "2026-11-25T02:00:00.000Z" });
    });

    it("--github sets an event wake", async () => {
      const t = setup();
      await t.run(boxWake, { github: "o/r", event: ["check_suite"], number: "7", action: ["completed"] }, ["w1"]);
      assert.deepEqual(t.client.wakes.get("w1"), {
        reason: "dozebox wake",
        on: { source: "github", repository: "o/r", events: ["check_suite"], number: 7, actions: ["completed"] },
      });
    });

    it("--cancel cancels", async () => {
      const t = setup();
      await t.run(boxWake, { at: NOW }, ["w1"]);
      const r = await t.run(boxWake, { cancel: true }, ["w1"]);
      assert.equal(t.client.wakes.has("w1"), false);
      assert.deepEqual(r.json, { id: "w1", cancelled: true });
    });

    for (const [name, args] of [
      ["neither --at nor --github", {}],
      ["both --at and --github", { at: NOW, github: "o/r", event: ["push"] }],
      ["--github without --event", { github: "o/r" }],
      ["--event with --at", { at: NOW, event: ["push"] }],
      ["bad --number", { github: "o/r", event: ["push"], number: "0" }],
      ["--cancel with --at", { cancel: true, at: NOW }],
      ["bad instant", { at: "later" }],
    ] as const) {
      it(`usage error: ${name}`, async () => {
        const t = setup();
        await assert.rejects(t.run(boxWake, args, ["w1"]), usage);
        assert.equal(t.client.wakes.size, 0);
      });
    }
  });

  describe("presence", () => {
    it("--for 10m interactive; --viewing", async () => {
      const t = setup();
      const seen = calls(t);
      await t.run(boxPresence, { for: "10m" }, ["tab-1"]);
      await t.run(boxPresence, { for: "90s", viewing: true }, ["tab-1"]);
      assert.deepEqual(seen, [
        ["tab-1", "interactive", 600],
        ["tab-1", "viewing", 90],
      ]);
    });

    it("defaults to 5m and allows exactly 15m", async () => {
      const t = setup();
      const seen = calls(t);
      await t.run(boxPresence, {}, ["a"]);
      await t.run(boxPresence, { for: "15m" }, ["a"]);
      assert.deepEqual(seen, [
        ["a", "interactive", 300],
        ["a", "interactive", 900],
      ]);
    });

    it("above 15m is a usage error", async () => {
      await assert.rejects(setup().run(boxPresence, { for: "16m" }, ["a"]), usage);
    });
  });

  describe("attention", () => {
    it("sends the alert", async () => {
      const t = setup();
      const r = await t.run(
        boxAttention,
        { severity: "page", title: "Disk", body: "full", url: "https://x.example/y" },
        ["disk-full"],
      );
      assert.deepEqual(t.client.attentions, [
        { key: "disk-full", severity: "page", title: "Disk", body: "full", url: "https://x.example/y" },
      ]);
      assert.deepEqual(r.json, { alertId: "a-1", deduped: false });
    });

    it("defaults to notify with the key as title", async () => {
      const t = setup();
      await t.run(boxAttention, {}, ["k"]);
      assert.deepEqual(t.client.attentions, [{ key: "k", severity: "notify", title: "k", body: "" }]);
    });

    it("rejects an unknown severity", async () => {
      await assert.rejects(setup().run(boxAttention, { severity: "loud" }, ["k"]), usage);
    });
  });

  describe("sleep", () => {
    it("accepted -> 0", async () => {
      const r = await setup().run(boxSleep, {});
      assert.equal(r.exitCode, EXIT.ok);
    });

    it("refused -> refused error naming the blockers (exit 5)", async () => {
      const t = setup();
      t.client.sleepBlockers = ["hold:agent/build", "presence:web/tab-1"];
      await assert.rejects(
        t.run(boxSleep, {}),
        (e: unknown) =>
          e instanceof DozeboxCliError &&
          e.code === "refused" &&
          e.message === "held awake by: hold:agent/build, presence:web/tab-1",
      );
    });

    it("--force goes through", async () => {
      const t = setup();
      t.client.sleepBlockers = ["hold:agent/build"];
      const r = await t.run(boxSleep, { force: true });
      assert.equal(r.exitCode, EXIT.ok);
    });
  });
});
