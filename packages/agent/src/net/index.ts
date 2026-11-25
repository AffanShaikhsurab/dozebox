// A6: network probe of two hosts with a strike counter, and the egress byte counter (D-017) from tx_bytes.
import type { Loop } from "../loops.ts";
import type { HostStats } from "../ports/host.ts";

export { makeLinuxHostStats } from "./hostStats.ts";

export const NET_LOOP_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

export type NetState = {
  readonly strikes: number;
  readonly lastOkAt: number | null;
  /** Bytes sent since agent start (counter resets are handled). */
  readonly txBytes: number;
};

export function netLoop(deps: {
  readonly stats: HostStats;
  readonly hosts: readonly [string, string];
  readonly now: () => number;
  readonly onState: (s: NetState) => void;
  readonly timeout?: (ms: number) => AbortSignal;
}): Loop {
  const timeout = deps.timeout ?? ((ms: number) => AbortSignal.timeout(ms));
  let strikes = 0;
  let lastOkAt: number | null = null;
  let txBytes = 0;
  let lastTx: number | null = null;
  return {
    name: "net",
    everyMs: NET_LOOP_MS,
    immediate: true,
    tick: async (signal) => {
      const probe = AbortSignal.any([signal, timeout(PROBE_TIMEOUT_MS)]);
      const answers = await Promise.all(deps.hosts.map((h) => deps.stats.reach(h, probe)));
      if (answers.some(Boolean)) {
        strikes = 0;
        lastOkAt = deps.now();
      } else strikes++;
      try {
        const current = await deps.stats.txBytes();
        if (lastTx !== null) txBytes += current >= lastTx ? current - lastTx : current;
        lastTx = current;
      } catch {
        // the counter is unreadable this tick; keep the total
      }
      deps.onState({ strikes, lastOkAt, txBytes });
    },
  };
}
