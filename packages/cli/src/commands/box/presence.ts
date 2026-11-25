import { DozeboxCliError, EXIT, type Command } from "../../command.ts";
import { parseDuration } from "../../duration.ts";
import { say, stringOpt } from "../../output.ts";
import { boxClient, flag, oneArg } from "./client.ts";

const MAX_MS = 15 * 60_000;
const DEFAULT_MS = 5 * 60_000;

export const boxPresence: Command = {
  name: "presence",
  summary: "Say a person is here (up to 15 minutes), so the box stays awake.",
  options: { for: { type: "string" }, viewing: { type: "boolean" } },
  mode: "box",
  mutates: true,
  run: async (ctx, values, given) => {
    const id = oneArg(given, "id");
    const client = boxClient(ctx);
    const forText = stringOpt(values, "for");
    const ms = forText === undefined ? DEFAULT_MS : parseDuration(forText);
    if (ms > MAX_MS) throw new DozeboxCliError("usage", "--for is at most 15m");
    const kind = flag(values, "viewing") ? "viewing" : "interactive";
    const seconds = Math.ceil(ms / 1000);
    await client.presence(id, kind, seconds);
    say(ctx, values, `presence ${id} (${kind}) for ${seconds}s`);
    return { exitCode: EXIT.ok, json: { id, kind, forSeconds: seconds } };
  },
};
