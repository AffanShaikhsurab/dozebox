import type { TSchema } from "typebox";
import Value from "typebox/value";

/** A value failed its schema after the tolerant-reader fallbacks were applied. */
export class ProtocolDecodeError extends Error {
  readonly schema: string;
  readonly problems: ReadonlyArray<string>;
  constructor(schema: string, problems: ReadonlyArray<string>) {
    super(`${schema} does not match: ${problems.slice(0, 3).join("; ")}`);
    this.name = "ProtocolDecodeError";
    this.schema = schema;
    this.problems = problems;
  }
}

/** Every problem as "<instance path>: <message>", for error text and logs. */
export function describeProblems(schema: TSchema, value: unknown): string[] {
  return [...Value.Errors(schema, value)].map((e) => `${e.instancePath || "/"}: ${e.message}`);
}

/** Check a value against a schema and return it typed, or throw ProtocolDecodeError. */
export function decode<T>(schema: TSchema, name: string, value: unknown): T {
  if (Value.Check(schema, value)) return value as T;
  throw new ProtocolDecodeError(name, describeProblems(schema, value));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Replace `obj[key]` with `fallback` when it is a string outside `known`. Returns a shallow copy when it changes. */
export function withFallback(
  obj: Record<string, unknown>,
  key: string,
  known: ReadonlyArray<string>,
  fallback: string,
): Record<string, unknown> {
  const v = obj[key];
  if (typeof v === "string" && !known.includes(v)) return { ...obj, [key]: fallback };
  return obj;
}
