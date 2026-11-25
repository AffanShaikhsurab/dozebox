// The control function's state table items (`kv#<key>`, fenced by the reconcile lease's token) as the drills write
// them: the fallback drill plants `last-start-error`, the restore drill makes the weekly test due. A drill writes with
// the lease's current token, which is never newer than the token of the next tick, so the control function's own
// fenced writes still succeed afterwards.
import { DozeboxCliError } from "../command.ts";
import { aws, obj, str } from "./box.ts";
import type { DrillContext } from "./types.ts";

export type Item = Readonly<Record<string, unknown>>;

const key = (name: string): string => JSON.stringify({ pk: { S: name } });

/** The current fencing token of `lease#reconcile` (1 when the control function never ticked). */
export async function leaseToken(ctx: DrillContext, signal: AbortSignal): Promise<number> {
  const s = await ctx.stack();
  const out = await aws(
    ctx,
    ["dynamodb", "get-item", "--table-name", s.stateTableName, "--key", key("lease#reconcile"), "--consistent-read"],
    signal,
  );
  const n = Number(str(obj(obj(obj(out["Item"])["fencing"]))["N"]) ?? "0");
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** The raw item `kv#<name>`, or null. */
export async function readItem(ctx: DrillContext, name: string, signal: AbortSignal): Promise<Item | null> {
  const s = await ctx.stack();
  const out = await aws(
    ctx,
    ["dynamodb", "get-item", "--table-name", s.stateTableName, "--key", key(`kv#${name}`), "--consistent-read"],
    signal,
  );
  const item = out["Item"];
  return typeof item === "object" && item !== null ? (item as Item) : null;
}

/** The JSON value stored in an item, or null. */
export function valueOf(item: Item | null): Readonly<Record<string, unknown>> | null {
  const text = str(obj(obj(item)["value"])["S"]);
  if (text === null) return null;
  try {
    return obj(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Writes `kv#<name>` the way the control function does (value as JSON text, fencing token), refused if a newer token wrote it. */
export async function putKv(
  ctx: DrillContext,
  name: string,
  value: unknown,
  token: number,
  signal: AbortSignal,
): Promise<void> {
  const s = await ctx.stack();
  const item = { pk: { S: `kv#${name}` }, value: { S: JSON.stringify(value) }, fencing: { N: String(token) } };
  await aws(
    ctx,
    [
      "dynamodb",
      "put-item",
      "--table-name",
      s.stateTableName,
      "--item",
      JSON.stringify(item),
      "--condition-expression",
      "attribute_not_exists(#f) OR #f <= :tok",
      "--expression-attribute-names",
      JSON.stringify({ "#f": "fencing" }),
      "--expression-attribute-values",
      JSON.stringify({ ":tok": { N: String(token) } }),
    ],
    signal,
  );
}

/** Puts `saved` back as it was read, or deletes `kv#<name>` when there was none. */
export async function restoreItem(
  ctx: DrillContext,
  name: string,
  saved: Item | null,
  signal: AbortSignal,
): Promise<void> {
  const s = await ctx.stack();
  if (saved === null) {
    await aws(ctx, ["dynamodb", "delete-item", "--table-name", s.stateTableName, "--key", key(`kv#${name}`)], signal);
    return;
  }
  if (str(obj(obj(saved)["pk"])["S"]) !== `kv#${name}`) {
    throw new DozeboxCliError("problem", `the saved item is not kv#${name}`);
  }
  await aws(ctx, ["dynamodb", "put-item", "--table-name", s.stateTableName, "--item", JSON.stringify(saved)], signal);
}
