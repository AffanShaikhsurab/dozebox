// A6: statfs of `/data` and `/` every minute -> disk level (`ok`, `low`, `critical`) and the `disk` event on change.
import type { DiskLevel } from "@dozebox/protocol/v1";
import type { Loop } from "../loops.ts";
import type { FsSpace, HostStats } from "../ports/host.ts";

export const DISK_LOOP_MS = 60_000;

export type DiskReading = { readonly path: string; readonly level: DiskLevel; readonly freePct: number };

/** Pure: free percent and level from statfs, with `low` below 10% and `critical` below 3%. */
export function diskLevel(_space: FsSpace): { readonly level: DiskLevel; readonly freePct: number } {
  throw new Error("not implemented: A6 diskLevel");
}

export function diskLoop(_deps: {
  readonly stats: Pick<HostStats, "space">;
  readonly paths: ReadonlyArray<string>;
  readonly onChange: (reading: DiskReading) => void;
}): Loop {
  throw new Error("not implemented: A6 diskLoop");
}
