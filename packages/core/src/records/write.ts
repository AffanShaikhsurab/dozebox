// Writing a record: check it, serialize it, and trim lists from the oldest end until it fits its SSM tier.
import { matchesSchema } from "@dozebox/protocol/records";
import { RunnerError } from "../errors.ts";
import {
  byteLength,
  RECORD_LIMIT_BYTES,
  RECORD_SPECS,
  type RecordName,
  type RecordTypes,
  type Tier,
} from "./registry.ts";

export type EncodedRecord = {
  readonly name: RecordName;
  readonly value: string;
  readonly tier: Tier;
  readonly bytes: number;
  /** True when lists were cut to fit; the record then also carries `truncated: true`. */
  readonly truncated: boolean;
};

/**
 * Serialize `record` for parameter `name`. Throws RunnerError `invalid_input` when the record does not match its
 * schema, or when it is still over the tier's limit after every trim (records without lists to trim).
 */
export function encodeRecord<N extends RecordName>(name: N, record: RecordTypes[N]): EncodedRecord {
  const spec = RECORD_SPECS[name];
  if (!matchesSchema(spec.schema, record)) {
    throw new RunnerError("invalid_input", false, `${name}: the record does not match its schema`);
  }
  const limit = RECORD_LIMIT_BYTES[spec.tier];
  let current: RecordTypes[N] = record;
  let truncated = false;
  for (;;) {
    const value = JSON.stringify(current);
    const bytes = byteLength(value);
    if (bytes <= limit) return { name, value, tier: spec.tier, bytes, truncated };
    const smaller = spec.trim?.(current) ?? null;
    if (smaller === null) {
      throw new RunnerError(
        "invalid_input",
        false,
        `${name}: ${bytes} bytes is over the ${spec.tier} limit of ${limit}`,
      );
    }
    current = smaller;
    truncated = true;
  }
}

const PARAM_NAME = /^[a-z0-9][a-z0-9_.-]*(\/[a-z0-9][a-z0-9_.-]*)*$/;

/**
 * Refuse a parameter write before it reaches the cloud: `name` must be a relative record path and `value` must fit
 * `tier`. Every RecordWriter and RecordStore calls this first, so an oversize record never costs an API call.
 */
export function assertFits(name: string, value: string, tier: Tier): void {
  if (!PARAM_NAME.test(name)) throw new RunnerError("invalid_input", false, `"${name}" is not a record name`);
  const bytes = byteLength(value);
  const limit = RECORD_LIMIT_BYTES[tier];
  if (bytes > limit) {
    throw new RunnerError("invalid_input", false, `${name}: ${bytes} bytes is over the ${tier} limit of ${limit}`);
  }
}
