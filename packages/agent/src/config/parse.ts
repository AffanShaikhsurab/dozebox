// Checking the box config and its payload definitions (part 5 §5.4, §5.5). Pure: text in, a value or the first
// problems out. Used for the copy in SSM and for the last good copy on disk alike.
import { BoxConfig } from "@dozebox/protocol/config";
import { PayloadDefinition, RESERVED_ENV } from "@dozebox/protocol/payload";
import { matchesSchema } from "@dozebox/protocol/records";
import { describeProblems } from "@dozebox/protocol/v1";

export type AgentConfig = {
  readonly box: BoxConfig;
  /** In the order of `box.payloads`. */
  readonly payloads: ReadonlyArray<PayloadDefinition>;
};

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

const bad = (problem: string): { ok: false; problem: string } => ({ ok: false, problem });

function json(name: string, text: string): Parsed<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return bad(`${name}: not JSON (${e instanceof Error ? e.message : String(e)})`);
  }
}

function checked<T>(name: string, schema: Parameters<typeof matchesSchema>[0], value: unknown): Parsed<T> {
  if (matchesSchema(schema, value)) return { ok: true, value: value as T };
  return bad(`${name}: ${describeProblems(schema, value).slice(0, 3).join("; ")}`);
}

/** `config` text -> BoxConfig for this box (`id` and `prefix` must be the box the agent runs for). */
export function parseBoxConfig(
  text: string | null,
  expect: { readonly boxId: string; readonly prefix: string },
): Parsed<BoxConfig> {
  if (text === null) return bad("config: the parameter does not exist");
  const raw = json("config", text);
  if (!raw.ok) return raw;
  const box = checked<BoxConfig>("config", BoxConfig, raw.value);
  if (!box.ok) return box;
  const { id, prefix } = box.value.box;
  if (id !== expect.boxId || prefix !== expect.prefix) {
    return bad(`config: written for ${prefix}/${id}, this agent is ${expect.prefix}/${expect.boxId}`);
  }
  const names = box.value.payloads;
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined) return bad(`config: payload "${dup}" is listed twice`);
  return box;
}

/** `payloads/<name>` text -> PayloadDefinition named `name`. */
export function parsePayload(name: string, text: string | null): Parsed<PayloadDefinition> {
  const where = `payloads/${name}`;
  if (text === null) return bad(`${where}: the parameter does not exist`);
  const raw = json(where, text);
  if (!raw.ok) return raw;
  const def = checked<PayloadDefinition>(where, PayloadDefinition, raw.value);
  if (!def.ok) return def;
  if (def.value.name !== name) return bad(`${where}: the definition is named "${def.value.name}"`);
  const reserved = Object.keys(def.value.start.env ?? {}).filter((k) =>
    (RESERVED_ENV as readonly string[]).includes(k),
  );
  if (reserved.length > 0) return bad(`${where}: start.env may not set ${reserved.join(", ")}`);
  return def;
}

/** The last good copy on disk: `{ box, payloads }` as written by the loader, checked like the SSM copy. */
export function parseLastGood(
  text: string | null,
  expect: { readonly boxId: string; readonly prefix: string },
): Parsed<AgentConfig> {
  if (text === null) return bad("last good config: none saved");
  const raw = json("last good config", text);
  if (!raw.ok) return raw;
  const v = raw.value as { box?: unknown; payloads?: unknown } | null;
  if (typeof v !== "object" || v === null || !Array.isArray(v.payloads)) return bad("last good config: bad shape");
  const box = parseBoxConfig(JSON.stringify(v.box ?? null), expect);
  if (!box.ok) return box;
  const defs: PayloadDefinition[] = [];
  for (const [i, name] of box.value.payloads.entries()) {
    const def = parsePayload(name, JSON.stringify(v.payloads[i] ?? null));
    if (!def.ok) return def;
    defs.push(def.value);
  }
  if (v.payloads.length !== defs.length) return bad("last good config: payloads do not match the config's list");
  return { ok: true, value: { box: box.value, payloads: defs } };
}
