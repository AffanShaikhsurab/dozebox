import { DozeboxCliError, EXIT, type Command } from "../../command.ts";
import { parseDuration } from "../../duration.ts";
import { say, stringOpt } from "../../output.ts";
import { boxClient, flag, oneArg } from "./client.ts";

const DEFAULT_EVERY_MS = 60_000;

export const boxBeat: Command = {
  name: "beat",
  summary: "Tell the box this payload is making progress, once or on a loop.",
  options: { loop: { type: "boolean" }, every: { type: "string" } },
  mode: "box",
  mutates: true,
  run: async (ctx, values, given) => {
    const name = oneArg(given, "name");
    const client = boxClient(ctx);
    const loop = flag(values, "loop");
    const every = stringOpt(values, "every");
    if (every !== undefined && !loop) throw new DozeboxCliError("usage", "--every needs --loop");
    const everyMs = every === undefined ? DEFAULT_EVERY_MS : parseDuration(every);
    const kind = loop ? "loop" : "progress";
    let sent = 0;
    for (;;) {
      await client.beat([{ kind, name }]);
      sent += 1;
      if (!loop) break;
      try {
        await ctx.deps.clock.sleep(everyMs, ctx.signal);
      } catch (e) {
        // An abort is the normal end of a loop.
        if (ctx.signal.aborted) break;
        throw e;
      }
      if (ctx.signal.aborted) break;
    }
    say(ctx, values, `beat ${name} x${sent}`);
    return { exitCode: EXIT.ok, json: { name, kind, beats: sent } };
  },
};
