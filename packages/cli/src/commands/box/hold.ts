import { DozeboxCliError, EXIT, type Command } from "../../command.ts";
import { parseDuration } from "../../duration.ts";
import { say, stringOpt } from "../../output.ts";
import { boxClient, flag, instantOpt, oneArg } from "./client.ts";

export const boxHold: Command = {
  name: "hold",
  summary: "Keep the box awake until a time, or release the hold.",
  options: {
    until: { type: "string" },
    for: { type: "string" },
    reason: { type: "string" },
    kind: { type: "string" },
    release: { type: "boolean" },
  },
  mode: "box",
  mutates: true,
  run: async (ctx, values, given) => {
    const id = oneArg(given, "id");
    const client = boxClient(ctx);
    const until = stringOpt(values, "until");
    const forText = stringOpt(values, "for");
    if (flag(values, "release")) {
      if (until !== undefined || forText !== undefined) {
        throw new DozeboxCliError("usage", "--release cannot be combined with --until or --for");
      }
      await client.release(id);
      say(ctx, values, `released hold ${id}`);
      return { exitCode: EXIT.ok, json: { id, released: true } };
    }
    if (until !== undefined && forText !== undefined) {
      throw new DozeboxCliError("usage", "use --until or --for, not both");
    }
    if (until === undefined && forText === undefined) {
      throw new DozeboxCliError("usage", "hold needs --until <iso> or --for <duration> (or --release)");
    }
    const kind = stringOpt(values, "kind");
    if (kind !== undefined && kind !== "work" && kind !== "wait") {
      throw new DozeboxCliError("usage", `--kind must be work or wait, got "${kind}"`);
    }
    const end =
      until !== undefined
        ? instantOpt("until", until)
        : new Date(ctx.deps.clock.now() + parseDuration(forText ?? "")).toISOString();
    const hold = await client.hold(id, {
      reason: stringOpt(values, "reason") ?? "dozebox hold",
      until: end,
      ...(kind !== undefined ? { kind } : {}),
    });
    say(ctx, values, `holding ${hold.id} until ${hold.until}${hold.clamped ? " (clamped)" : ""}`);
    return { exitCode: EXIT.ok, json: hold };
  },
};
