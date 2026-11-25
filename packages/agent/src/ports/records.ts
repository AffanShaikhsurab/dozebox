// The box writes its records (`rec/*`, `fence/*`) under `/<prefix>/<boxId>/`. Values come from core's encodeRecord.
import type { Tier } from "@dozebox/core/records";

export interface RecordWriter {
  /** Refused with RunnerError `invalid_input` before any call when `value` is over the tier's limit. */
  readonly put: (name: string, value: string, opts: { readonly tier: Tier }) => Promise<void>;
  /** Deleting a missing record is not an error. */
  readonly delete: (name: string) => Promise<void>;
}
