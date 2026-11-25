import { DozeboxCliError, EXIT, type Command } from "../../command.ts";
import { say } from "../../output.ts";
import { boxClient, flag } from "./client.ts";

export const boxSleep: Command = {
  name: "sleep",
  summary: "Ask the box to park now.",
  options: { force: { type: "boolean" } },
  mode: "box",
  mutates: true,
  run: async (ctx, values) => {
    const answer = await boxClient(ctx).sleep({ force: flag(values, "force") });
    if (!answer.accepted) {
      throw new DozeboxCliError("refused", `held awake by: ${answer.blockers.join(", ")}`);
    }
    say(ctx, values, "sleeping");
    return { exitCode: EXIT.ok, json: answer };
  },
};
