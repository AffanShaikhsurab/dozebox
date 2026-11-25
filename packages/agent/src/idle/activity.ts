// Health-only activity (part 4 §4.16): a payload with `protocol: "none"` counts as active while its unit's cgroup used
// more than `activity.cpuPercent` (default 5) of one CPU, averaged over at least ACTIVITY_WINDOW_MS. Read from
// `cpu.stat` `usage_usec`. An unhealthy payload is never active. Process output never counts.
import type { PayloadDefinition } from "@dozebox/protocol/payload";
import type { Files } from "../ports/files.ts";

export const ACTIVITY_WINDOW_MS = 60_000;
export const DEFAULT_CPU_PERCENT = 5;
export const CGROUP_ROOT = "/sys/fs/cgroup/dozebox.slice/dozebox-payloads.slice";

export const cpuStatPath = (name: string): string => `${CGROUP_ROOT}/dozebox-payload@${name}.service/cpu.stat`;

/** `usage_usec` from a cgroup v2 `cpu.stat`, or null. */
export function usageUsec(text: string | null): number | null {
  const m = text?.match(/^usage_usec (\d+)$/m);
  return m?.[1] === undefined ? null : Number(m[1]);
}

type Sample = { readonly at: number; readonly usec: number };

export interface ActivitySampler {
  /** Take one sample of every health-only payload; returns the newest activity time seen so far, or null. */
  readonly sample: (now: number) => Promise<number | null>;
  readonly lastActivityAt: () => number | null;
}

export function makeActivitySampler(deps: {
  readonly files: Pick<Files, "readText">;
  readonly payloads: () => ReadonlyArray<PayloadDefinition>;
  /** Names whose last health check passed. */
  readonly healthy: (name: string) => boolean;
}): ActivitySampler {
  const history = new Map<string, Sample[]>();
  let last: number | null = null;

  const one = async (def: PayloadDefinition, now: number): Promise<void> => {
    const usec = usageUsec(await deps.files.readText(cpuStatPath(def.name)).catch(() => null));
    if (usec === null) {
      history.delete(def.name);
      return;
    }
    const samples = [...(history.get(def.name) ?? []), { at: now, usec }];
    // Keep the newest sample at least one window old, plus everything after it.
    let base = 0;
    for (let i = samples.length - 1; i >= 0; i--) {
      if (now - (samples[i]?.at ?? now) >= ACTIVITY_WINDOW_MS) {
        base = i;
        break;
      }
    }
    const kept = samples.slice(base);
    history.set(def.name, kept);
    const first = kept[0];
    if (!first || now - first.at < ACTIVITY_WINDOW_MS || usec < first.usec) return;
    const percent = ((usec - first.usec) / 1000 / (now - first.at)) * 100;
    if (percent > (def.activity?.cpuPercent ?? DEFAULT_CPU_PERCENT) && deps.healthy(def.name)) last = now;
  };

  return {
    sample: async (now) => {
      const defs = deps.payloads().filter((d) => d.protocol === "none");
      await Promise.all(defs.map((d) => one(d, now)));
      return last;
    },
    lastActivityAt: () => last,
  };
}
