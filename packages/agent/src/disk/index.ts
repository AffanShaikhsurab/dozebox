// A6: statfs of `/data` and `/` every minute -> disk level (`ok`, `low`, `critical`) and the `disk` event on change.
import type { DiskLevel } from "@dozebox/protocol/v1";
import type { Loop } from "../loops.ts";
import type { FsSpace, HostStats } from "../ports/host.ts";

export const DISK_LOOP_MS = 60_000;

export type DiskReading = { readonly path: string; readonly level: DiskLevel; readonly freePct: number };

export type DiskThresholds = { readonly lowPct: number; readonly criticalPct: number; readonly hysteresisPct: number };

/** The box config defaults (`disk` in BoxConfig). */
export const DISK_DEFAULTS: DiskThresholds = { lowPct: 15, criticalPct: 5, hysteresisPct: 3 };

const RANK: Record<DiskLevel, number> = { ok: 0, low: 1, critical: 2 };
const LEVELS: ReadonlyArray<DiskLevel> = ["ok", "low", "critical"];

const levelAt = (freePct: number, lowPct: number, criticalPct: number): DiskLevel =>
  freePct < criticalPct ? "critical" : freePct < lowPct ? "low" : "ok";

/**
 * Pure: free percent and level from statfs. The level gets worse as soon as free space is under a threshold and
 * better only once it is `hysteresisPct` above it, so a reading hovering at a threshold does not flap.
 */
export function diskLevel(
  space: FsSpace,
  t: DiskThresholds = DISK_DEFAULTS,
  previous?: DiskLevel,
): { readonly level: DiskLevel; readonly freePct: number } {
  const freePct = space.totalBytes > 0 ? (space.freeBytes / space.totalBytes) * 100 : 0;
  const raw = levelAt(freePct, t.lowPct, t.criticalPct);
  if (previous === undefined) return { level: raw, freePct };
  const relaxed = levelAt(freePct, t.lowPct + t.hysteresisPct, t.criticalPct + t.hysteresisPct);
  const held = Math.min(RANK[previous], RANK[relaxed]);
  return { level: LEVELS[Math.max(RANK[raw], held)] ?? raw, freePct };
}

export function diskLoop(deps: {
  readonly stats: Pick<HostStats, "space">;
  readonly paths: ReadonlyArray<string>;
  readonly onChange: (reading: DiskReading) => void;
  readonly thresholds?: DiskThresholds;
}): Loop {
  const last = new Map<string, DiskLevel>();
  return {
    name: "disk",
    everyMs: DISK_LOOP_MS,
    immediate: true,
    tick: async () => {
      for (const path of deps.paths) {
        const { level, freePct } = diskLevel(await deps.stats.space(path), deps.thresholds, last.get(path));
        if (last.get(path) === level) continue;
        last.set(path, level);
        deps.onChange({ path, level, freePct });
      }
    },
  };
}
