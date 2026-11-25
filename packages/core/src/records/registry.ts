// Every record the box writes (part 4 §4.14): its schema, its SSM tier, and how to shrink it when it is too big.
import {
  BootTimelineRecord,
  FormattedRecord,
  LastErrorRecord,
  LastWordsRecord,
  LivenessRecord,
  matchesSchema,
  RECORD_LIMIT_BYTES,
  RECORD_NAMES,
  ServingRecord,
  SleepFence,
  WakesRecord,
} from "@dozebox/protocol/records";

type TSchema = Parameters<typeof matchesSchema>[0];

export type Tier = keyof typeof RECORD_LIMIT_BYTES;

/** The record type stored under each parameter name. */
export type RecordTypes = {
  readonly "rec/liveness": LivenessRecord;
  readonly "rec/wakes": WakesRecord;
  readonly "rec/serving": ServingRecord;
  readonly "rec/last-words": LastWordsRecord;
  readonly "rec/last-error": LastErrorRecord;
  readonly "rec/boot-timeline": BootTimelineRecord;
  readonly "rec/formatted": FormattedRecord;
  readonly "fence/sleep-requested": SleepFence;
};
export type RecordName = keyof RecordTypes;

/** One step smaller, with `truncated: true`, or null when nothing is left to drop. */
type Trim<T> = (record: T) => T | null;

type Spec<T> = { readonly schema: TSchema; readonly tier: Tier; readonly trim: Trim<T> | null };

/**
 * Lists are kept oldest first, so trimming drops index 0. The two exceptions say "newest first" in the protocol
 * (`holds.reasons`) or are keyed maps (`progress`); for those the oldest entry is dropped instead.
 */
const trimLiveness: Trim<LivenessRecord> = (r) => {
  if (r.undelivered.length > 0) return { ...r, undelivered: r.undelivered.slice(1), truncated: true };
  const withReasons = r.payloads.findIndex((p) => p.holds.reasons.length > 0);
  if (withReasons >= 0) {
    const payloads = r.payloads.map((p, i) =>
      i === withReasons ? { ...p, holds: { ...p.holds, reasons: p.holds.reasons.slice(0, -1) } } : p,
    );
    return { ...r, payloads, truncated: true };
  }
  const withProgress = r.payloads.findIndex((p) => Object.keys(p.progress).length > 0);
  if (withProgress >= 0) {
    const payloads = r.payloads.map((p, i) => {
      if (i !== withProgress) return p;
      const entries = Object.entries(p.progress).toSorted((a, b) => a[1].localeCompare(b[1]));
      return { ...p, progress: Object.fromEntries(entries.slice(1)) };
    });
    return { ...r, payloads, truncated: true };
  }
  return null;
};

const trimWakes: Trim<WakesRecord> = (r) =>
  r.wakes.length > 0 ? { ...r, wakes: r.wakes.slice(1), truncated: true } : null;

export const RECORD_SPECS: { readonly [N in RecordName]: Spec<RecordTypes[N]> } = {
  [RECORD_NAMES.liveness]: { schema: LivenessRecord, tier: "Advanced", trim: trimLiveness },
  [RECORD_NAMES.wakes]: { schema: WakesRecord, tier: "Advanced", trim: trimWakes },
  [RECORD_NAMES.serving]: { schema: ServingRecord, tier: "Standard", trim: null },
  [RECORD_NAMES.lastWords]: { schema: LastWordsRecord, tier: "Standard", trim: null },
  [RECORD_NAMES.lastError]: { schema: LastErrorRecord, tier: "Standard", trim: null },
  [RECORD_NAMES.bootTimeline]: { schema: BootTimelineRecord, tier: "Standard", trim: null },
  [RECORD_NAMES.formatted]: { schema: FormattedRecord, tier: "Standard", trim: null },
  [RECORD_NAMES.sleepFence]: { schema: SleepFence, tier: "Standard", trim: null },
};

/** Serialized size in bytes, the way SSM counts it (UTF-8). */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export { RECORD_LIMIT_BYTES };
