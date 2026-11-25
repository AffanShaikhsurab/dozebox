// A6: poll IMDS `spot/instance-action` every 5 s; on a notice publish `reclaim-notice` and park with reason `reclaim`
// within `stopGraceSeconds` (two minutes of notice on AWS, minus the park time).
import type { Loop } from "../loops.ts";
import type { SpotAction, SpotNotices } from "../ports/host.ts";

export const SPOT_POLL_MS = 5_000;

export function spotLoop(_deps: {
  readonly notices: SpotNotices;
  readonly now: () => number;
  readonly onNotice: (notice: SpotAction) => Promise<void>;
}): Loop {
  throw new Error("not implemented: A6 spotLoop");
}
