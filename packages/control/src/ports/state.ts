// The control function's own state: the reconcile lease with a fencing token, fenced writes and idempotency keys.

export type Lease = { readonly holder: string; readonly token: number; readonly expiresAt: number };

export interface StateTable {
  /**
   * Grant the lease `name` to `holder` when it is free, expired, or already held by `holder`. The token grows on
   * every grant. Returns null when someone else holds it.
   */
  readonly acquireLease: (name: string, holder: string, ttlMs: number, now: number) => Promise<Lease | null>;
  /** Refused with RunnerError code "lease_lost" when `token` is older than the stored one. */
  readonly putFenced: (key: string, value: unknown, token: number) => Promise<void>;
  /** Write once. An entry older than its `ttlSeconds` counts as absent. */
  readonly putIfAbsent: (key: string, value: unknown, ttlSeconds: number) => Promise<"written" | "exists">;
  /** The value of a fenced write or a live idempotency entry, or null. */
  readonly get: (key: string) => Promise<unknown | null>;
}
