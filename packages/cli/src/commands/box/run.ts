import { DozeboxCliError, EXIT, type Command } from "../../command.ts";
import { say, stringOpt } from "../../output.ts";
import { boxClient, flag } from "./client.ts";

const BEAT_EVERY_MS = 30_000;

/** A hold id (`^[a-z0-9][a-z0-9._:-]{0,63}$`) made from the command's first word. */
function defaultHoldId(argv0: string): string {
  const base = argv0.split(/[\\/]/).pop() ?? argv0;
  const clean = `run-${base}`.toLowerCase().replace(/[^a-z0-9._:-]/g, "-");
  return clean.slice(0, 64);
}

export const boxRun: Command = {
  name: "run",
  summary: "Run a command while holding the box awake; beat on output, alert on failure.",
  options: { "hold-id": { type: "string" }, reason: { type: "string" }, "no-attention": { type: "boolean" } },
  mode: "box",
  mutates: true,
  run: async (ctx, values, argv) => {
    const client = boxClient(ctx);
    const first = argv[0];
    if (first === undefined) throw new DozeboxCliError("usage", "run needs a command: dozebox run -- <cmd...>");
    const holdId = stringOpt(values, "hold-id") ?? defaultHoldId(first);
    const reason = stringOpt(values, "reason") ?? `running ${argv.join(" ")}`.slice(0, 120);
    const hold = client.keepHold(holdId, { reason, forSeconds: 600, renewEverySeconds: 120, kind: "work" });
    let lastBeat = Number.NEGATIVE_INFINITY;
    let exitCode: number;
    try {
      const result = await ctx.deps.exec.run(argv, {
        signal: ctx.signal,
        onOutput: () => {
          const now = ctx.deps.clock.now();
          if (now - lastBeat < BEAT_EVERY_MS) return;
          lastBeat = now;
          // Best effort: a lost beat must not kill the command.
          client.beat([{ kind: "progress", name: "run" }]).catch(() => {});
        },
      });
      exitCode = result.exitCode;
    } finally {
      await hold.stop();
    }
    if (exitCode !== 0 && !flag(values, "no-attention")) {
      await client.attention({
        key: `run-failed:${holdId}`,
        severity: "notify",
        title: `${holdId} failed`.slice(0, 120),
        body: `exit ${exitCode}`,
      });
    }
    say(ctx, values, `${first} exited ${exitCode}`);
    return { exitCode: exitCode === 0 ? EXIT.ok : EXIT.problem, json: { exitCode } };
  },
};
