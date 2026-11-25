import { toInstant } from "@dozebox/core/time";
import type { AgentEventSink } from "../protocol/server.ts";
import type { ParkReason } from "../phase.ts";
import type { SpotAction } from "../ports/host.ts";

export const DEFAULT_STOP_GRACE_SECONDS = 60;

export function makeReclaim(deps: {
  readonly publish: AgentEventSink;
  readonly park: (reason: ParkReason, detail: string) => Promise<void>;
  readonly stopGraceSeconds: number;
}): (notice: SpotAction) => Promise<void> {
  let published = false;
  let parking = false;
  return async (notice) => {
    if (parking) return;
    parking = true;
    const at = toInstant(notice.at);
    try {
      if (!published) {
        published = true;
        deps.publish("reclaim-notice", { terminationAt: at, stopGraceSeconds: deps.stopGraceSeconds });
      }
      await deps.park("reclaim", `spot ${notice.action} at ${at}`);
    } catch (e) {
      parking = false;
      throw e;
    }
  };
}
