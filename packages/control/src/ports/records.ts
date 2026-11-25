// The records parameters under `/<prefix>/<boxId>/`. The control function reads `rec/*` and writes only `ctl/*`.
import type { Tier } from "@dozebox/core/records";

export type StoredRecord = {
  /** Relative to the box root, such as `rec/liveness`. */
  readonly name: string;
  readonly value: string;
  /** Epoch ms of the last write. */
  readonly modifiedAt: number;
};

export interface RecordStore {
  /** Every parameter under the box root, in one paginated read (one call per tick). */
  readonly readAll: () => Promise<ReadonlyArray<StoredRecord>>;
  readonly get: (name: string) => Promise<StoredRecord | null>;
  /** Refused with RunnerError `invalid_input` before any call when `value` is over the tier's limit. */
  readonly put: (name: string, value: string, opts: { readonly tier: Tier }) => Promise<void>;
  /** Deleting a missing record is not an error. */
  readonly delete: (name: string) => Promise<void>;
}
