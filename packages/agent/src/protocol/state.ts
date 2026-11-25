// A2: the store's persisted shape (`protocol.json`) and the small pure helpers around it. Times are epoch ms.
import { toInstant } from "@dozebox/core/time";
import type { HoldKind, PresenceKind, Wake, WakeMatch } from "@dozebox/protocol/v1";

export type HoldEntry = {
  readonly payload: string;
  readonly id: string;
  readonly reason: string;
  readonly kind: HoldKind;
  readonly since: number;
  readonly requestedUntil: number;
  readonly until: number;
};

export type WakeEntry = {
  readonly payload: string;
  readonly id: string;
  readonly reason: string;
  readonly at?: number;
  readonly on?: WakeMatch;
  readonly expiresAt: number;
};

export type PresenceEntry = {
  readonly payload: string;
  readonly id: string;
  readonly kind: PresenceKind;
  readonly until: number;
  readonly label: string | null;
};

export type BeatEntry = {
  readonly payload: string;
  readonly kind: "progress" | "loop";
  readonly name: string;
  at: number;
  expectEveryMs: number | null;
};

export type HealthEntry = {
  readonly payload: string;
  readonly ok: boolean;
  readonly detail: string | null;
  readonly until: number;
};

export type StoreState = {
  readonly v: 1;
  readonly bootId: string;
  holds: HoldEntry[];
  wakes: WakeEntry[];
  presence: PresenceEntry[];
  beats: BeatEntry[];
  health: HealthEntry[];
  lastInteractiveAt: number | null;
};

export const emptyState = (bootId: string): StoreState => ({
  v: 1,
  bootId,
  holds: [],
  wakes: [],
  presence: [],
  beats: [],
  health: [],
  lastInteractiveAt: null,
});

const LISTS = ["holds", "wakes", "presence", "beats", "health"] as const;

/** The file's state, or null when it is missing or not ours (then the store starts empty). */
export function parseState(text: string | null): StoreState | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r["v"] !== 1 || typeof r["bootId"] !== "string") return null;
  if (!LISTS.every((k) => Array.isArray(r[k]))) return null;
  const at = r["lastInteractiveAt"];
  if (at !== null && typeof at !== "number") return null;
  // Our own root-only file, written by this module: the list shapes are trusted after the structural check.
  return raw as StoreState;
}

export const isLive = (until: number, now: number): boolean => until > now;

/** Runner presence sources (`src:*`) are box-wide; payload entries are `<payload>/<id>`. */
export const presenceKey = (payload: string, id: string): string => (id.startsWith("src:") ? id : `${payload}/${id}`);

export function wakeOf(w: WakeEntry): Wake {
  return {
    id: w.id,
    reason: w.reason,
    ...(w.at === undefined ? {} : { at: toInstant(w.at) }),
    ...(w.on === undefined ? {} : { on: w.on }),
    expiresAt: toInstant(w.expiresAt),
  };
}

/** Bytes of `rec/wakes` with this set, with a writer of the longest instance id. */
export function wakeRecordBytes(wakes: ReadonlyArray<WakeEntry>, bootId: string, now: number): number {
  const record = {
    v: 1,
    at: toInstant(now),
    writer: { instanceId: "i-0123456789abcdef0", bootId },
    atPark: false,
    wakes: wakes.map((w) => ({ payload: w.payload, ...wakeOf(w) })),
  };
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}
