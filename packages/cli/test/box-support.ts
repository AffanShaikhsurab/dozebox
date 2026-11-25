// Shared setup for the box command tests: a fake agent client over protocol fixtures and a command context.
import type { Hold, Status, Wake } from "@dozebox/protocol/v1";
import type { Command, CommandContext, CommandResult } from "../src/command.ts";
import { makeFakeCliDeps, makeFakeClock, makeFakeDozeboxClient, controlStatusFixture } from "@dozebox/testkit/fakes";

export const NOW = "2026-11-25T00:00:00.000Z";

export const holdFixture = (id: string): Hold => ({
  id,
  reason: "r",
  kind: "work",
  since: NOW,
  requestedUntil: "2026-11-25T01:00:00.000Z",
  until: "2026-11-25T01:00:00.000Z",
  clamped: false,
});

export const wakeFixture = (id: string): Wake => ({
  id,
  reason: "r",
  at: "2026-11-25T02:00:00.000Z",
  expiresAt: "2026-11-25T03:00:00.000Z",
});

export const statusFixture: Status = {
  box: {
    id: "main",
    phase: "serving",
    since: NOW,
    instance: { id: "i-1", type: "m7i.xlarge", az: "us-east-1a", lifecycle: "spot" },
    bootedAt: NOW,
    memoryBytes: 1,
    cpus: 4,
    controlUrl: null,
  },
  jail: { ready: true, egress: "allowlist", missing: [] },
  idle: { since: null, sleepAt: null, awakeBecause: ["hold:agent/build"] },
  disk: { level: "ok", freePct: 80, freeBytes: 1, at: NOW },
  caps: { awakeSecondsToday: 10, awakeSecondsCap: null },
  holds: [],
  wakes: [],
};

export function setup(opts: { readonly agent?: boolean } = {}) {
  const client = makeFakeDozeboxClient({
    status: () => statusFixture,
    hello: () => {
      throw new Error("unused");
    },
    hold: holdFixture,
    wake: wakeFixture,
    attention: () => ({ alertId: "a-1", deduped: false }),
  });
  const clock = makeFakeClock(Date.parse(NOW));
  const deps = {
    ...makeFakeCliDeps({ status: controlStatusFixture(), clock }),
    agentSocket: opts.agent === false ? null : client,
  };
  const lines: string[] = [];
  const abort = new AbortController();
  const ctx: CommandContext = {
    argv: [],
    stdout: (l) => void lines.push(l),
    stderr: () => {},
    env: {},
    signal: abort.signal,
    deps,
  };
  const run = (cmd: Command, args: Record<string, unknown>, pos: ReadonlyArray<string> = []): Promise<CommandResult> =>
    cmd.run(ctx, args, pos);
  return { client, clock, deps, ctx, lines, abort, run };
}
