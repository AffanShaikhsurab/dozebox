// Host facts the A6 watchers read: the Spot notice (IMDSv2 `spot/instance-action`), filesystem space, network bytes
// and reachability. Linux adapters live in `adapters/`; tests use testkit fakes-agent.

export type SpotAction = { readonly action: "stop" | "terminate" | "hibernate"; readonly at: number };

export interface SpotNotices {
  /** The pending interruption, or null (IMDS answers 404 when there is none). */
  readonly instanceAction: (signal?: AbortSignal) => Promise<SpotAction | null>;
}

export type FsSpace = { readonly totalBytes: number; readonly freeBytes: number };

export interface HostStats {
  /** statfs of the filesystem holding `path`. */
  readonly space: (path: string) => Promise<FsSpace>;
  /** Sum of `/sys/class/net/<if>/statistics/tx_bytes` over every interface except `lo`. */
  readonly txBytes: () => Promise<number>;
  /** One TCP or HTTPS reachability probe; true when it answered within `signal`. */
  readonly reach: (host: string, signal: AbortSignal) => Promise<boolean>;
}
