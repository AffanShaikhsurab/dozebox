// `dozebox alerts test|path` (L2): a test alert through every sink (`POST /v1/alerts/test`), and the alert path
// verdict the control function reports in its status (exit 1 when alerts cannot reach anyone).
import { DozeboxCliError, EXIT, type Command } from "../command.ts";
import { positionals, say, stringOpt } from "../output.ts";

export const alertsTest: Command = {
  name: "alerts test",
  summary: "Send a test alert through every sink.",
  options: { severity: { type: "string" } },
  mode: "operator",
  mutates: true,
  run: async (ctx, values, args) => {
    positionals(args, []);
    const severity = stringOpt(values, "severity") ?? "notify";
    if (severity !== "page" && severity !== "notify")
      throw new DozeboxCliError("usage", "--severity is page or notify");
    await ctx.deps.control.alertsTest(severity);
    say(ctx, values, `Test ${severity} alert sent; check every sink (email, ntfy, phone).`);
    return { exitCode: EXIT.ok, json: { sent: severity } };
  },
};

export const alertsPath: Command = {
  name: "alerts path",
  summary: "Show the alert path verdict.",
  options: {},
  mode: "operator",
  mutates: false,
  run: async (ctx, values, args) => {
    positionals(args, []);
    const path = (await ctx.deps.control.status(ctx.signal)).alertPath;
    say(ctx, values, `Alert path: ${path.level}${path.say === undefined ? "" : ` (${path.say})`}`);
    return { exitCode: path.level === "bad" ? EXIT.problem : EXIT.ok, json: path };
  },
};
