// `dozebox phone pair|list|revoke` (L2). A paired phone holds the wake token and its own approve token; only the
// approve token's SHA-256 is stored, as `<ssm_prefix>phones/<id>` = `{"hash","label","at"}` (String; a hash is not a
// secret). The pairing link carries both tokens in the URL fragment, which browsers never send to a server.
import { createHash, randomBytes } from "node:crypto";
import { toInstant } from "@dozebox/core/time";
import { DozeboxCliError, EXIT, type Command } from "../command.ts";
import { stackOf } from "../context.ts";
import { confirmDestructive, positionals, say, stringOpt } from "../output.ts";
import type { StackContext } from "../stack.ts";
import { newWakeToken } from "../token.ts";

const LABEL = /^[\p{L}\p{N} _.'-]{1,40}$/u;
const ID = /^[a-f0-9]{12}$/;

const phonesPath = (stack: StackContext): string => `${stack.ssmPrefix}phones/`;

type PhoneRecord = { readonly hash: string; readonly label: string; readonly at: string };

function readPhone(text: string | null): PhoneRecord | null {
  if (text === null) return null;
  try {
    const p = JSON.parse(text) as Partial<PhoneRecord>;
    return typeof p.hash === "string" && typeof p.label === "string" && typeof p.at === "string"
      ? { hash: p.hash, label: p.label, at: p.at }
      : null;
  } catch {
    return null;
  }
}

export const phonePair: Command = {
  name: "phone pair",
  summary: "Pair a phone: prints a link with the wake token and a new approve token.",
  options: { label: { type: "string" } },
  mode: "operator",
  mutates: true,
  run: async (ctx, values, args) => {
    positionals(args, []);
    const label = stringOpt(values, "label") ?? "phone";
    if (!LABEL.test(label)) throw new DozeboxCliError("usage", "--label is 1 to 40 letters, digits, spaces or _ . ' -");
    const stack = await stackOf(ctx, values);
    const { aws, clock } = ctx.deps;
    const wakeToken = await aws.getParameter(stack.wakeTokenParameter);
    if (wakeToken === null || wakeToken === "")
      throw new DozeboxCliError("not-set-up", "No wake token; run `dozebox setup`.");
    const id = randomBytes(6).toString("hex");
    const approve = newWakeToken();
    const record: PhoneRecord = {
      hash: createHash("sha256").update(approve, "utf8").digest("hex"),
      label,
      at: toInstant(clock.now()),
    };
    await aws.putParameter(`${phonesPath(stack)}${id}`, JSON.stringify(record), { secure: false });
    const link = `${stack.controlUrl}/#t=${wakeToken}&a=${approve}&p=${id}`;
    say(ctx, values, `Open this on the phone (once; it is not shown again):`);
    say(ctx, values, link);
    return { exitCode: EXIT.ok, json: { id, label, link } };
  },
};

export const phoneList: Command = {
  name: "phone list",
  summary: "List paired phones.",
  options: {},
  mode: "operator",
  mutates: false,
  run: async (ctx, values, args) => {
    positionals(args, []);
    const stack = await stackOf(ctx, values);
    const names = await ctx.deps.aws.listParameters(phonesPath(stack));
    const phones: Array<{ readonly id: string; readonly label: string; readonly at: string }> = [];
    for (const n of names) {
      const p = readPhone(await ctx.deps.aws.getParameter(n));
      if (p !== null) phones.push({ id: n.slice(phonesPath(stack).length), label: p.label, at: p.at });
    }
    if (phones.length === 0) say(ctx, values, "No paired phones.");
    for (const p of phones) say(ctx, values, `${p.id}  ${p.at}  ${p.label}`);
    return { exitCode: EXIT.ok, json: { phones } };
  },
};

export const phoneRevoke: Command = {
  name: "phone revoke",
  summary: "Revoke a paired phone's approve token.",
  options: {},
  mode: "operator",
  mutates: true,
  run: async (ctx, values, args) => {
    const [id = ""] = positionals(args, ["id"]);
    if (!ID.test(id)) throw new DozeboxCliError("usage", `${id} is not a phone id (see dozebox phone list)`);
    const stack = await stackOf(ctx, values);
    const name = `${phonesPath(stack)}${id}`;
    if ((await ctx.deps.aws.getParameter(name)) === null) throw new DozeboxCliError("usage", `no phone ${id}`);
    await confirmDestructive(
      ctx,
      values,
      `Revoke phone ${id}? It keeps the wake token; run token rotate for that too.`,
    );
    await ctx.deps.aws.deleteParameter(name);
    say(ctx, values, `Revoked ${id}. The phone can still wake the box until you run \`dozebox token rotate\`.`);
    return { exitCode: EXIT.ok, json: { revoked: id } };
  },
};
