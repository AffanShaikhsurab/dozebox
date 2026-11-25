// C2: the transactional outbox for alerts (part 6 §6.3): one item per (alert, sink), written `pending` before any
// delivery, marked `sent` after, retried by every tick with backoff, `failed` 24 h after the alert.
// The whole outbox is one fenced state item (`kv#outbox`): StateTable has no query, alerts are few, and one item
// makes every change a single conditional write under the tick's token. Settled items are dropped 24 h after the
// alert, which keeps the item far below DynamoDB's 400 KB and still dedupes a re-enqueue of the same alert.
import { DAY, type Clock } from "@dozebox/core/time";
import { Type } from "typebox";
import Value from "typebox/value";
import type { Alert } from "../ports/alertSink.ts";
import type { StateTable } from "../ports/state.ts";

export type OutboxStatus = "pending" | "sent" | "failed";

export type OutboxItem = {
  readonly alertId: string;
  readonly sink: string;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly alert: Alert;
};

const BACKOFF_MS = [60_000, 120_000, 240_000, 480_000];
const LATER_MS = 900_000;

/** Retry delays 1, 2, 4, 8 min, then every 15 min, each with +-20% jitter from `rand` (0 to 1). */
export function nextAttempt(attempts: number, now: number, rand: () => number): number {
  const base = BACKOFF_MS[attempts] ?? LATER_MS;
  const jitter = 1 + (rand() * 0.4 - 0.2);
  return now + Math.round(base * jitter);
}

export interface Outbox {
  /** Write one `pending` item per sink; an item that already exists for (alert, sink) is left as it is. */
  readonly enqueue: (alert: Alert, sinks: ReadonlyArray<string>, token: number) => Promise<void>;
  /** `pending` items with `nextAttemptAt <= now`, oldest first. */
  readonly due: (now: number) => Promise<ReadonlyArray<OutboxItem>>;
  readonly markSent: (item: OutboxItem, token: number) => Promise<void>;
  /** Count one failed attempt: reschedule, or `failed` after 24 h. Returns the stored item. */
  readonly markAttempt: (item: OutboxItem, reason: string, token: number) => Promise<OutboxItem>;
}

const OUTBOX_KEY = "outbox";

const Stored = Type.Object({
  items: Type.Array(
    Type.Object({
      alertId: Type.String(),
      sink: Type.String(),
      status: Type.Union([Type.Literal("pending"), Type.Literal("sent"), Type.Literal("failed")]),
      attempts: Type.Integer({ minimum: 0 }),
      nextAttemptAt: Type.Number(),
      alert: Type.Object({
        id: Type.String(),
        key: Type.String(),
        severity: Type.Union([Type.Literal("page"), Type.Literal("notify"), Type.Literal("info")]),
        title: Type.String(),
        body: Type.String(),
        url: Type.Optional(Type.String()),
        source: Type.String(),
        at: Type.Number(),
      }),
    }),
  ),
});

const same = (a: Pick<OutboxItem, "alertId" | "sink">, b: Pick<OutboxItem, "alertId" | "sink">): boolean =>
  a.alertId === b.alertId && a.sink === b.sink;

export function makeOutbox(deps: {
  readonly state: StateTable;
  readonly clock: Pick<Clock, "now">;
  readonly rand: () => number;
}): Outbox {
  const read = async (): Promise<ReadonlyArray<OutboxItem>> => {
    const raw = await deps.state.get(OUTBOX_KEY);
    return Value.Check(Stored, raw) ? raw.items : [];
  };
  const write = async (items: ReadonlyArray<OutboxItem>, token: number): Promise<void> => {
    const now = deps.clock.now();
    const kept = items.filter((i) => i.status === "pending" || now - i.alert.at < DAY);
    await deps.state.putFenced(OUTBOX_KEY, { items: kept }, token);
  };
  const update = async (item: OutboxItem, next: OutboxItem, token: number): Promise<OutboxItem> => {
    const items = await read();
    const stored = items.find((i) => same(i, item));
    // Settled since this caller read it (another drain): keep what is stored.
    if (stored === undefined || stored.status !== "pending") return stored ?? item;
    await write(
      items.map((i) => (same(i, item) ? next : i)),
      token,
    );
    return next;
  };

  return {
    enqueue: async (alert, sinks, token) => {
      const items = await read();
      const now = deps.clock.now();
      const added = [...new Set(sinks)]
        .filter((sink) => !items.some((i) => same(i, { alertId: alert.id, sink })))
        .map((sink): OutboxItem => ({
          alertId: alert.id,
          sink,
          status: "pending",
          attempts: 0,
          nextAttemptAt: now,
          alert,
        }));
      if (added.length > 0) await write([...items, ...added], token);
    },
    due: async (now) =>
      (await read())
        .filter((i) => i.status === "pending" && i.nextAttemptAt <= now)
        .toSorted((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.alert.at - b.alert.at),
    markSent: async (item, token) => {
      await update(item, { ...item, status: "sent" }, token);
    },
    markAttempt: (item, _reason, token) => {
      const now = deps.clock.now();
      const expired = now - item.alert.at >= DAY;
      const next: OutboxItem = expired
        ? { ...item, attempts: item.attempts + 1, status: "failed" }
        : { ...item, attempts: item.attempts + 1, nextAttemptAt: nextAttempt(item.attempts, now, deps.rand) };
      return update(item, next, token);
    },
  };
}
