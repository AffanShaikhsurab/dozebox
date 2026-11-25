// A6: network probe of two hosts with a strike counter, and the egress byte counter (D-017) from tx_bytes.
import type { Loop } from "../loops.ts";
import type { HostStats } from "../ports/host.ts";

export const NET_LOOP_MS = 30_000;

export type NetState = {
  readonly strikes: number;
  readonly lastOkAt: number | null;
  /** Bytes sent since agent start (counter resets are handled). */
  readonly txBytes: number;
};

export function netLoop(_deps: {
  readonly stats: HostStats;
  readonly hosts: readonly [string, string];
  readonly now: () => number;
  readonly onState: (s: NetState) => void;
}): Loop {
  throw new Error("not implemented: A6 netLoop");
}
