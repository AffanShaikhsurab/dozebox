// What keeps the box awake, as the idle loop (A5) reads it. A2's protocol store implements it; until then the
// default NO_HOLDS answers "nothing" and the box runs in health-only mode.
import type { IdleHold, IdlePresence } from "@dozebox/core/idle";
import type { RecordTypes } from "@dozebox/core/records";

export type BoxWakeRequests = RecordTypes["rec/wakes"]["wakes"];

export interface HoldSource {
  /** Live holds at `now` (expired ones left out). */
  readonly holds: (now: number) => Promise<ReadonlyArray<IdleHold>>;
  readonly presence: (now: number) => Promise<ReadonlyArray<IdlePresence>>;
  /** Epoch ms of the newest progress beat, or null. */
  readonly lastProgressAt: () => Promise<number | null>;
  readonly lastInteractiveAt: () => Promise<number | null>;
  /** The wake requests to leave in `rec/wakes` at park. */
  readonly wakeRequests: () => Promise<BoxWakeRequests>;
}

export const NO_HOLDS: HoldSource = {
  holds: async () => [],
  presence: async () => [],
  lastProgressAt: async () => null,
  lastInteractiveAt: async () => null,
  wakeRequests: async () => [],
};
