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
