// A6: poll IMDS `spot/instance-action` every 5 s; each distinct notice goes to `onNotice` once (reclaim.ts publishes
// `reclaim-notice` and parks; imds.ts reads the notice).
import type { Loop } from "../loops.ts";
import type { SpotAction, SpotNotices } from "../ports/host.ts";

export { DEFAULT_STOP_GRACE_SECONDS, makeReclaim } from "./reclaim.ts";
export { makeImdsSpotNotices } from "./imds.ts";

export const SPOT_POLL_MS = 5_000;

export function spotLoop(deps: {
  readonly notices: SpotNotices;
  readonly now: () => number;
  readonly onNotice: (notice: SpotAction) => Promise<void>;
}): Loop {
  let seen: string | null = null;
  return {
    name: "spot",
    everyMs: SPOT_POLL_MS,
    immediate: true,
    tick: async (signal) => {
      const notice = await deps.notices.instanceAction(signal);
      if (notice === null) return;
      const key = `${notice.action}@${notice.at}`;
      if (key === seen) return;
      await deps.onNotice(notice);
      seen = key;
    },
  };
}
