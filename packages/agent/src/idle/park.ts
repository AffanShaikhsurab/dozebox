// A5: the park sequence. Order matters (part 3 §3.4): last words, wakes at park, the fence, stop payloads, stop self.
import type { Clock } from "@dozebox/core/time";
import type { ErrorLog } from "../errors.ts";
import type { ParkReason } from "../phase.ts";
import type { HoldSource } from "../ports/holds.ts";
import type { PayloadSupervisor } from "../ports/payloads.ts";
import type { SelfStop, SelfStopTarget } from "../ports/selfstop.ts";
import type { RecordPublisher } from "../records/publish.ts";

export type ParkDeps = {
  readonly clock: Clock;
  /** `rec/last-words`, `rec/wakes`, `fence/sleep-requested`. */
  readonly records: Pick<RecordPublisher, "put">;
  readonly errors: Pick<ErrorLog, "recent">;
  readonly holds: HoldSource;
  readonly payloads: Pick<PayloadSupervisor, "stopAll">;
  readonly selfStop: SelfStop;
  readonly target: SelfStopTarget;
};

/** Payloads get this long to stop before the stop call goes out anyway. */
export const PAYLOAD_STOP_MS = 60_000;

export function park(_deps: ParkDeps, _reason: ParkReason, _detail: string): Promise<void> {
  throw new Error("not implemented: A5 park");
}
