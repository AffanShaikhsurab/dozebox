// A2: the event stream's memory: the last EVENT_REPLAY_LIMIT events with ids `<bootId>-<n>` (n restarts at boot),
// replay after a `Last-Event-ID`, and live subscribers. Data is checked against EVENT_SCHEMAS before it is kept.
import type { HubEvent } from "./wire.ts";

export interface EventHub {
  /** Refuses (throws TypeError) an unknown event name or data that fails its schema: that is a bug in the agent. */
  readonly publish: (name: string, data: unknown, payload?: string | null) => HubEvent;
  /**
   * Kept events after `lastEventId` that `viewer` may see (viewer null = admin, sees all). Null, an id from another
   * boot, or text that is not an id replays nothing (the client re-reads /v1/status); an id of this boot older than
   * the kept window replays every kept event.
   */
  readonly since: (lastEventId: string | null, viewer: string | null) => ReadonlyArray<HubEvent>;
  /** Live events for `viewer`. Returns the unsubscribe function. */
  readonly subscribe: (viewer: string | null, fn: (e: HubEvent) => void) => () => void;
}

export function makeEventHub(_deps: { readonly bootId: string; readonly limit?: number }): EventHub {
  throw new Error("not implemented: A2 makeEventHub");
}
