/** Time comes in through this port, so decisions stay pure and tests control it. */
export interface Clock {
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Use instead of AbortSignal.timeout(ms): fake timers in node:test do not control AbortSignal.timeout, so
   * timeout code is only testable through this port.
   */
  readonly timeout: (ms: number) => AbortSignal;
}

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Epoch ms -> the protocol's `Instant` (RFC 3339 UTC, milliseconds, trailing Z). */
export function toInstant(ms: number): string {
  return new Date(ms).toISOString();
}

/** The protocol's `Instant` -> epoch ms, or null when the text is not one. */
export function parseInstant(value: unknown): number | null {
  if (typeof value !== "string" || !INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Milliseconds since `at`, never negative (a clock a little ahead of ours reads as "just now"). */
export function ageMs(now: number, at: number | null): number | null {
  return at === null ? null : Math.max(0, now - at);
}
