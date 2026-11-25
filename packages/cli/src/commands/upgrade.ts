// `dozebox upgrade --agent <version>`: records `agent_version` in the stack's `dozebox.auto.tfvars.json` (Terraform
// loads it on every later plan, so a later deploy keeps the version) and applies. The box picks the new agent up at
// its next boot. The stack root declares `variable "agent_version"` (examples/drill does).
import { DozeboxCliError, EXIT, type Command } from "../command.ts";
import { stackDirOf } from "../context.ts";
import { say, stringOpt } from "../output.ts";
import type { CliFiles } from "../ports/terraform.ts";

const VERSION = /^(none|\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/;

const tfvarsFile = (dir: string): string => `${dir.replace(/[\\/]+$/, "")}/dozebox.auto.tfvars.json`;

/** Merge `values` into the stack's auto tfvars file; a file that is not a JSON object is a problem, not overwritten. */
async function writeTfvars(fs: CliFiles, dir: string, values: Readonly<Record<string, string>>): Promise<void> {
  const path = tfvarsFile(dir);
  const text = await fs.readText(path);
  let current: Record<string, unknown> = {};
  if (text !== null) {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new DozeboxCliError("problem", `${path} is not a JSON object; fix it by hand`);
    }
    current = parsed as Record<string, unknown>;
  }
  await fs.writeText(path, `${JSON.stringify({ ...current, ...values }, null, 2)}\n`);
}

export const upgrade: Command = {
  name: "upgrade",
  summary: "Set the agent version and apply.",
  options: { agent: { type: "string" } },
  mode: "operator",
  mutates: true,
  run: async (ctx, values) => {
    const version = stringOpt(values, "agent");
    if (version === undefined) throw new DozeboxCliError("usage", "missing --agent <version>");
    if (!VERSION.test(version)) throw new DozeboxCliError("usage", `--agent ${version} is not a version like 1.2.3`);
    const dir = stackDirOf(values);
    await writeTfvars(ctx.deps.fs, dir, { agent_version: version });
    const { terraform } = ctx.deps;
    await terraform.init(dir, ctx.signal);
    const changed = await terraform.plan(dir, {}, ctx.signal);
    if (changed) await terraform.apply(dir, {}, ctx.signal);
    say(
      ctx,
      values,
      changed ? `Agent ${version} set; the box uses it from its next boot.` : `Agent ${version} already set.`,
    );
    return { exitCode: EXIT.ok, json: { agentVersion: version, applied: changed } };
  },
};
