// C3: read EC2, the group, the volumes, the records and the intent into one snapshot (one read of each).
import type { Snapshot, TickDeps } from "./types.ts";

export function observe(_deps: TickDeps, _now: number): Promise<Snapshot> {
  throw new Error("not implemented: C3 observe");
}
