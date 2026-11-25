// A2: strict request checking (part 4 §4.15 rule 2): an unknown field is `unknown_field` naming it, a missing
// required field or a body that is not an object is `bad_request`, any other schema failure is `invalid_value`.
import { matchesSchema } from "@dozebox/protocol/records";
import { describeProblems } from "@dozebox/protocol/v1";
import { ProtocolError } from "./errors.ts";

type SchemaNode = {
  readonly type?: unknown;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly additionalProperties?: unknown;
  readonly required?: ReadonlyArray<string>;
  readonly items?: SchemaNode;
  readonly anyOf?: ReadonlyArray<SchemaNode>;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const join = (path: string, key: string | number): string =>
  typeof key === "number" ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`;

/** The first field that is not in a closed object schema, as a dotted path; unions are left to the schema check. */
function unknownField(schema: SchemaNode, value: unknown, path: string): string | null {
  if (schema.properties !== undefined && isObject(value)) {
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties[key];
      if (sub === undefined) {
        if (schema.additionalProperties === false) return join(path, key);
        continue;
      }
      const found = unknownField(sub, v, join(path, key));
      if (found !== null) return found;
    }
  }
  if (schema.items !== undefined && Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const found = unknownField(schema.items, v, join(path, i));
      if (found !== null) return found;
    }
  }
  return null;
}

function missingField(schema: SchemaNode, value: unknown, path: string): string | null {
  if (!isObject(value) || schema.properties === undefined) return null;
  for (const key of schema.required ?? []) if (!(key in value)) return join(path, key);
  for (const [key, sub] of Object.entries(schema.properties)) {
    const found = key in value ? missingField(sub, value[key], join(path, key)) : null;
    if (found !== null) return found;
  }
  return null;
}

/** `/beats/0/at` -> `beats[0].at`. */
function fieldOf(instancePath: string): string {
  return instancePath
    .split("/")
    .filter((p) => p !== "")
    .reduce<string>((acc, p) => join(acc, /^\d+$/.test(p) ? Number(p) : p), "");
}

type Schema = Parameters<typeof matchesSchema>[0];

/** `T` is the schema's static type; the caller names it (`checkBody<HoldInput>(HoldInput, body)`). */
export function checkBody<T>(schema: Schema, body: unknown): T {
  if (!isObject(body)) throw new ProtocolError("bad_request", "the body must be a JSON object");
  const node = schema as unknown as SchemaNode;
  const unknown = unknownField(node, body, "");
  if (unknown !== null) throw new ProtocolError("unknown_field", `unknown field ${unknown}`, { field: unknown });
  const missing = missingField(node, body, "");
  if (missing !== null) throw new ProtocolError("bad_request", `missing field ${missing}`, { field: missing });
  if (matchesSchema(schema, body)) return body as T;
  const first = describeProblems(schema, body)[0] ?? "/: invalid value";
  const cut = first.indexOf(": ");
  const field = fieldOf(first.slice(0, cut));
  throw new ProtocolError("invalid_value", first.slice(cut + 2), field ? { field } : {});
}
