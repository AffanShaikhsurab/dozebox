// A2: the protocol's limits (part 4 §4.6-4.10), announced in `hello` and enforced by the store and the routes.

export const LIMITS = {
  holdsPerPayload: 64,
  /** Default `holdMaxSeconds`; a payload definition may raise it up to 86,400. */
  holdMaxSeconds: 28_800,
  wakesPerPayload: 10,
  wakesPerBox: 20,
  /** 35 days. */
  wakeHorizonSeconds: 3_024_000,
  presenceMaxSeconds: 900,
  presencePerPayload: 16,
  attentionPerHour: 30,
  pagesPerHour: 5,
  beatNamesPerPayload: 32,
  /** Beats may be this far in the past and in the future. */
  beatPastSeconds: 300,
  beatFutureSeconds: 5,
  /** The serialized `rec/wakes` must stay under this (the record's tier holds 8 KiB). */
  wakesRecordBytes: 7_680,
} as const;

/** Default lifetime of a wake request after its `at` (timed) or after now (event). */
export const WAKE_AT_EXPIRY_MS = 60 * 60_000;
export const WAKE_EVENT_EXPIRY_MS = 7 * 24 * 60 * 60_000;
