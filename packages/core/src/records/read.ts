// Reading a record: unknown versions read as missing, records from another instance are ignored (rules R4, §4.14).
import { matchesSchema, type WriterTag } from "@dozebox/protocol/records";
import { RECORD_SPECS, type RecordName, type RecordTypes } from "./registry.ts";

export type RecordRead<T> =
  | { readonly kind: "ok"; readonly record: T }
  /** `unknown-version` is the metric `RecordVersionUnknown`; the reader never guesses at a newer shape. */
  | { readonly kind: "missing"; readonly why: "absent" | "not-json" | "unknown-version" | "invalid" }
  | { readonly kind: "ignored"; readonly why: "wrong-writer"; readonly writer: WriterTag };

/** The instance in service. `bootId` narrows the check to one boot; without it any boot of the instance counts. */
export type InService = { readonly instanceId: string; readonly bootId?: string };

const KNOWN_VERSION = 1;

/**
 * Parse the raw parameter value of record `name`. Pass `inService: null` when no instance is in service; then the
 * writer is not compared (the caller decides what a record without a serving instance means).
 */
export function readRecord<N extends RecordName>(
  name: N,
  raw: string | null,
  inService: InService | null,
): RecordRead<RecordTypes[N]> {
  if (raw === null) return { kind: "missing", why: "absent" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "missing", why: "not-json" };
  }
  const v: unknown = typeof value === "object" && value !== null ? (value as { readonly v?: unknown }).v : undefined;
  if (typeof v === "number" && v > KNOWN_VERSION) return { kind: "missing", why: "unknown-version" };
  if (!matchesSchema(RECORD_SPECS[name].schema, value)) return { kind: "missing", why: "invalid" };
  const record = value as RecordTypes[N];
  const writer = record.writer;
  if (
    inService !== null &&
    (writer.instanceId !== inService.instanceId ||
      (inService.bootId !== undefined && writer.bootId !== inService.bootId))
  ) {
    return { kind: "ignored", why: "wrong-writer", writer };
  }
  return { kind: "ok", record };
}
