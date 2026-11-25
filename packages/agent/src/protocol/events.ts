// A2: the event stream's memory: the last EVENT_REPLAY_LIMIT events with ids `<bootId>-<n>` (n restarts at boot),
// replay after a `Last-Event-ID`, and live subscribers. Data is checked against EVENT_SCHEMAS before it is kept.
import { EVENT_REPLAY_LIMIT, EVENT_SCHEMAS } from "@dozebox/protocol/v1";
import { matchesSchema } from "@dozebox/protocol/records";
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

type Kept = { readonly seq: number; readonly event: HubEvent };
type Subscriber = { readonly viewer: string | null; readonly fn: (e: HubEvent) => void };

const visible = (e: HubEvent, viewer: string | null): boolean =>
  viewer === null || e.payload === null || e.payload === viewer;

export function makeEventHub(deps: { readonly bootId: string; readonly limit?: number }): EventHub {
  const limit = deps.limit ?? EVENT_REPLAY_LIMIT;
  const prefix = `${deps.bootId}-`;
  const kept: Kept[] = [];
  const subscribers = new Set<Subscriber>();
  let counter = 0;

  const seqOf = (id: string): number | null => {
    if (!id.startsWith(prefix)) return null;
    const rest = id.slice(prefix.length);
    return /^\d+$/.test(rest) ? Number(rest) : null;
  };

  return {
    publish: (name, data, payload = null) => {
      if (!Object.hasOwn(EVENT_SCHEMAS, name)) throw new TypeError(`unknown event name: ${name}`);
      const schema = EVENT_SCHEMAS[name as keyof typeof EVENT_SCHEMAS];
      if (!matchesSchema(schema, data)) throw new TypeError(`event ${name}: data does not match its schema`);
      counter += 1;
      const event: HubEvent = { id: `${prefix}${counter}`, name, data, payload };
      kept.push({ seq: counter, event });
      if (kept.length > limit) kept.splice(0, kept.length - limit);
      for (const s of subscribers) if (visible(event, s.viewer)) s.fn(event);
      return event;
    },
    since: (lastEventId, viewer) => {
      if (lastEventId === null) return [];
      const after = seqOf(lastEventId);
      if (after === null) return [];
      return kept.filter((k) => k.seq > after && visible(k.event, viewer)).map((k) => k.event);
    },
    subscribe: (viewer, fn) => {
      const s: Subscriber = { viewer, fn };
      subscribers.add(s);
      return () => void subscribers.delete(s);
    },
  };
}
