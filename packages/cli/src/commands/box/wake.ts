import type { WakeInput } from "@dozebox/protocol/v1";
import { DozeboxCliError, EXIT, type Command } from "../../command.ts";
import { say, stringOpt } from "../../output.ts";
import { boxClient, flag, instantOpt, oneArg, stringsOpt } from "./client.ts";

export const boxWake: Command = {
  name: "wake",
  summary: "Ask the box to wake at a time or on a GitHub event, or cancel that request.",
  options: {
    at: { type: "string" },
    github: { type: "string" },
    event: { type: "string", multiple: true },
    number: { type: "string" },
    action: { type: "string", multiple: true },
    reason: { type: "string" },
    cancel: { type: "boolean" },
  },
  mode: "box",
  mutates: true,
  run: async (ctx, values, given) => {
    const id = oneArg(given, "id");
    const client = boxClient(ctx);
    const at = stringOpt(values, "at");
    const repository = stringOpt(values, "github");
    const events = stringsOpt(values, "event");
    const actions = stringsOpt(values, "action");
    const number = stringOpt(values, "number");
    if (flag(values, "cancel")) {
      if (at !== undefined || repository !== undefined) {
        throw new DozeboxCliError("usage", "--cancel cannot be combined with --at or --github");
      }
      await client.cancelWake(id);
      say(ctx, values, `cancelled wake ${id}`);
      return { exitCode: EXIT.ok, json: { id, cancelled: true } };
    }
    if (at !== undefined && repository !== undefined)
      throw new DozeboxCliError("usage", "use --at or --github, not both");
    const reason = stringOpt(values, "reason") ?? "dozebox wake";
    let input: WakeInput;
    if (at === undefined && repository === undefined) {
      throw new DozeboxCliError("usage", "wake needs --at <iso> or --github <owner/repo> --event <e> (or --cancel)");
    } else if (at !== undefined) {
      if (events.length > 0 || actions.length > 0 || number !== undefined) {
        throw new DozeboxCliError("usage", "--event, --action and --number go with --github");
      }
      input = { reason, at: instantOpt("at", at) };
    } else if (repository !== undefined) {
      if (events.length === 0) throw new DozeboxCliError("usage", "--github needs at least one --event");
      const n = number === undefined ? undefined : Number(number);
      if (n !== undefined && (!Number.isInteger(n) || n < 1)) {
        throw new DozeboxCliError("usage", "--number must be a positive whole number");
      }
      input = {
        reason,
        on: {
          source: "github",
          repository,
          events: [...events],
          ...(n !== undefined ? { number: n } : {}),
          ...(actions.length > 0 ? { actions: [...actions] } : {}),
        },
      };
    } else {
      throw new DozeboxCliError("usage", "use --at or --github, not both");
    }
    const wake = await client.wake(id, input);
    say(ctx, values, `wake ${wake.id} set, expires ${wake.expiresAt}`);
    return { exitCode: EXIT.ok, json: wake };
  },
};
