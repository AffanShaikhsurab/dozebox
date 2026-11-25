import { EXIT, type Command } from "../../command.ts";
import { say } from "../../output.ts";
import { boxClient } from "./client.ts";

export const boxStatus: Command = {
  name: "status",
  summary: "Show this box's phase, what keeps it awake, holds and wakes.",
  options: {},
  mode: "box",
  mutates: false,
  run: async (ctx, values) => {
    const s = await boxClient(ctx).status();
    say(ctx, values, `${s.box.id}: ${s.box.phase} since ${s.box.since}`);
    say(
      ctx,
      values,
      s.idle.awakeBecause.length > 0 ? `awake because: ${s.idle.awakeBecause.join(", ")}` : "nothing keeps it awake",
    );
    if (s.idle.sleepAt !== null) say(ctx, values, `sleeps at ${s.idle.sleepAt}`);
    say(ctx, values, `${s.holds.length} hold(s), ${s.wakes.length} wake(s), disk ${s.disk.level}`);
    return { exitCode: EXIT.ok, json: s };
  },
};
