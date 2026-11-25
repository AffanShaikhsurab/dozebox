// `dozebox secrets set|list|delete` (L2): SecureString parameters under `/<prefix>/shared/` that payload definitions
// and sinks reference by name. A value is read from stdin (or a no-echo prompt), never from argv: it would land in
// shell history and `ps`.
import { DozeboxCliError, EXIT, type Command } from "../command.ts";
import { stackOf } from "../context.ts";
import { confirmDestructive, positionals, say } from "../output.ts";

const NAME = /^[A-Za-z0-9_.-]{1,128}$/;

function secretName(args: ReadonlyArray<string>, extra: string): string {
  if (args.length > 1) throw new DozeboxCliError("usage", extra);
  const [name = ""] = positionals(args, ["name"]);
  if (!NAME.test(name)) throw new DozeboxCliError("usage", `${name} is not a secret name (letters, digits, _ . -)`);
  return name;
}

export const secretsSet: Command = {
  name: "secrets set",
  summary: "Store a shared secret; the value is read from stdin, never from a flag.",
  options: {},
  mode: "operator",
  mutates: true,
  run: async (ctx, values, args) => {
    const name = secretName(
      args,
      "secret values come from stdin, never from arguments: echo -n ... | dozebox secrets set <name>",
    );
    await stackOf(ctx, values);
    const value = await ctx.deps.prompt.secret(`Value for ${name}`);
    if (value === "") throw new DozeboxCliError("usage", "empty value; nothing stored");
    await ctx.deps.aws.putSecret(name, value);
    say(ctx, values, `Stored ${name}.`);
    return { exitCode: EXIT.ok, json: { stored: name } };
  },
};

export const secretsList: Command = {
  name: "secrets list",
  summary: "List the shared secret names (never values).",
  options: {},
  mode: "operator",
  mutates: false,
  run: async (ctx, values, args) => {
    positionals(args, []);
    await stackOf(ctx, values);
    const names = (await ctx.deps.aws.listSecrets()).toSorted();
    if (names.length === 0) say(ctx, values, "No shared secrets.");
    for (const n of names) say(ctx, values, n);
    return { exitCode: EXIT.ok, json: { secrets: names } };
  },
};

export const secretsDelete: Command = {
  name: "secrets delete",
  summary: "Delete a shared secret.",
  options: {},
  mode: "operator",
  mutates: true,
  run: async (ctx, values, args) => {
    const name = secretName(args, "secrets delete takes one name");
    await stackOf(ctx, values);
    if (!(await ctx.deps.aws.listSecrets()).includes(name)) throw new DozeboxCliError("usage", `no secret ${name}`);
    await confirmDestructive(ctx, values, `Delete shared secret ${name}? Payloads and sinks that use it stop working.`);
    await ctx.deps.aws.deleteSecret(name);
    say(ctx, values, `Deleted ${name}.`);
    return { exitCode: EXIT.ok, json: { deleted: name } };
  },
};
