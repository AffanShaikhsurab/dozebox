import { DozeboxCliError, EXIT, type Command } from "../../command.ts";
import { say, stringOpt } from "../../output.ts";
import { boxClient, oneArg } from "./client.ts";

const SEVERITIES = ["page", "notify", "info"] as const;

export const boxAttention: Command = {
  name: "attention",
  summary: "Send the operator an alert, deduplicated by key.",
  options: {
    severity: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    url: { type: "string" },
  },
  mode: "box",
  mutates: true,
  run: async (ctx, values, given) => {
    const key = oneArg(given, "key");
    const client = boxClient(ctx);
    const severity = stringOpt(values, "severity") ?? "notify";
    const known = SEVERITIES.find((s) => s === severity);
    if (known === undefined) {
      throw new DozeboxCliError("usage", `--severity must be one of ${SEVERITIES.join(", ")}, got "${severity}"`);
    }
    const url = stringOpt(values, "url");
    const accepted = await client.attention({
      key: key,
      severity: known,
      title: stringOpt(values, "title") ?? key,
      body: stringOpt(values, "body") ?? "",
      ...(url !== undefined ? { url } : {}),
    });
    say(ctx, values, accepted.deduped ? `alert ${accepted.alertId} already sent` : `alert ${accepted.alertId} sent`);
    return { exitCode: EXIT.ok, json: accepted };
  },
};
