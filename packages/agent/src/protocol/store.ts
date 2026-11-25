// A2: the protocol's in-memory state with atomic JSON persistence under `/data/dozebox/protocol.json`. Holds and wakes
// survive an agent restart within one boot; a new boot id clears them. Implements HoldSource for the idle loop (A5).
import type { IdleHold, IdlePresence } from "@dozebox/core/idle";
import { toInstant } from "@dozebox/core/time";
import type { Beat, Hold, HoldInput, Presence, PresenceInput, Wake, WakeInput } from "@dozebox/protocol/v1";
import type { Files } from "../ports/files.ts";
import type { BoxWakeRequests, HoldSource } from "../ports/holds.ts";
import { ProtocolError } from "./errors.ts";
import { LIMITS } from "./limits.ts";
import {
  emptyState,
  isLive,
  parseState,
  presenceKey,
  wakeOf,
  wakeRecordBytes,
  type HealthEntry,
  type HoldEntry,
  type StoreState,
  type WakeEntry,
} from "./state.ts";
import { parseWakeInput } from "./wakeInput.ts";

export type PayloadBeats = {
  /** Newest progress beat per name, epoch ms. */
  readonly progress: Readonly<Record<string, number>>;
  /** Loop beats with a deadline that have missed it at `now`: `<name>`. */
  readonly missedLoops: ReadonlyArray<string>;
};

export interface ProtocolStore extends HoldSource {
  /** Every key is `<payload>/<id>`. Clamps `until` to the hold cap and reports it (`hold-clamped`). */
  readonly putHold: (payload: string, id: string, input: HoldInput, now: number) => Promise<Hold>;
  readonly deleteHold: (payload: string, id: string) => Promise<boolean>;
  readonly listHolds: (payload: string | null, now: number) => ReadonlyArray<Hold>;
  readonly putWake: (payload: string, id: string, input: WakeInput, now: number) => Promise<Wake>;
  readonly deleteWake: (payload: string, id: string) => Promise<boolean>;
  readonly listWakes: (payload: string | null, now: number) => ReadonlyArray<Wake>;
  readonly putPresence: (payload: string, id: string, input: PresenceInput, now: number) => Promise<Presence>;
  readonly deletePresence: (payload: string, id: string) => Promise<boolean>;
  readonly beats: (payload: string, beats: ReadonlyArray<Beat>, now: number) => Promise<void>;
  readonly beatsOf: (payload: string, now: number) => PayloadBeats;
  /** `PUT /v1/health`: counts until `ttlSeconds` passes. */
  readonly putHealth: (
    payload: string,
    input: { readonly ok: boolean; readonly detail?: string; readonly ttlSeconds: number },
    now: number,
  ) => Promise<void>;
  /** The payload's live self-report, or null. */
  readonly healthOf: (payload: string, now: number) => { readonly ok: boolean; readonly detail: string | null } | null;
}

export type ProtocolStoreDeps = {
  readonly files: Files;
  readonly path: string;
  readonly bootId: string;
  /** The payload's `limits.holdMaxSeconds`. Default LIMITS.holdMaxSeconds. */
  readonly holdMaxSeconds?: (payload: string) => number;
  /** When the awake cap ends every hold (epoch ms), or null without a cap. */
  readonly holdCapAt?: () => number | null;
  /** Called when the awake cap cut a hold short. */
  readonly onClamped?: (payload: string, id: string, until: number) => void;
};

const holdOf = (h: HoldEntry): Hold => ({
  id: h.id,
  reason: h.reason,
  kind: h.kind,
  since: toInstant(h.since),
  requestedUntil: toInstant(h.requestedUntil),
  until: toInstant(h.until),
  clamped: h.until < h.requestedUntil,
});

const byPayload = <T extends { payload: string }>(list: ReadonlyArray<T>, payload: string | null): T[] =>
  list.filter((e) => payload === null || e.payload === payload);

export async function makeProtocolStore(deps: ProtocolStoreDeps): Promise<ProtocolStore> {
  const loaded = parseState(await deps.files.readText(deps.path));
  const s: StoreState = loaded !== null && loaded.bootId === deps.bootId ? loaded : emptyState(deps.bootId);
  let chain: Promise<void> = loaded === s ? Promise.resolve() : write();

  function write(): Promise<void> {
    const text = JSON.stringify(s);
    return deps.files.writeAtomic(deps.path, text);
  }
  /** Writes run one after another, each with the state at the time it starts; the caller waits for its own. */
  const persist = (): Promise<void> => {
    const mine = chain.catch(() => {}).then(write);
    chain = mine;
    return mine;
  };
  const prune = (now: number): void => {
    s.holds = s.holds.filter((h) => isLive(h.until, now));
    s.presence = s.presence.filter((p) => isLive(p.until, now));
    s.wakes = s.wakes.filter((w) => isLive(w.expiresAt, now));
    s.health = s.health.filter((h) => isLive(h.until, now));
  };
  const remove = async (list: "holds" | "wakes" | "presence", payload: string, id: string): Promise<boolean> => {
    const entries: Array<{ readonly payload: string; readonly id: string }> = s[list];
    const i = entries.findIndex((e) => e.payload === payload && e.id === id);
    if (i < 0) return false;
    entries.splice(i, 1);
    await persist();
    return true;
  };

  const store: ProtocolStore = {
    putHold: async (payload, id, input, now) => {
      const requestedUntil = Date.parse(input.until);
      if (!(requestedUntil > now))
        throw new ProtocolError("invalid_value", "until must be in the future", { field: "until" });
      prune(now);
      const old = s.holds.find((h) => h.payload === payload && h.id === id);
      if (!old && s.holds.filter((h) => h.payload === payload).length >= LIMITS.holdsPerPayload) {
        throw new ProtocolError("limit_exceeded", `at most ${LIMITS.holdsPerPayload} live holds per payload`);
      }
      const payloadMax = deps.holdMaxSeconds?.(payload) ?? LIMITS.holdMaxSeconds;
      const maxMs = Math.min(input.maxSeconds ?? payloadMax, payloadMax) * 1000;
      const since = old?.since ?? now;
      const capAt = deps.holdCapAt?.() ?? null;
      const byMax = Math.min(requestedUntil, since + maxMs);
      const until = Math.max(now, capAt === null ? byMax : Math.min(byMax, capAt));
      const entry: HoldEntry = {
        payload,
        id,
        reason: input.reason,
        kind: input.kind ?? "work",
        since,
        requestedUntil,
        until,
      };
      s.holds = [...s.holds.filter((h) => h !== old), entry];
      await persist();
      if (capAt !== null && until < byMax) deps.onClamped?.(payload, id, until);
      return holdOf(entry);
    },
    deleteHold: (payload, id) => remove("holds", payload, id),
    listHolds: (payload, now) =>
      byPayload(s.holds, payload)
        .filter((h) => isLive(h.until, now))
        .map(holdOf),

    putWake: async (payload, id, input, now) => {
      const parsed = parseWakeInput(input, now);
      prune(now);
      const others = s.wakes.filter((w) => !(w.payload === payload && w.id === id));
      if (others.filter((w) => w.payload === payload).length >= LIMITS.wakesPerPayload) {
        throw new ProtocolError("limit_exceeded", `at most ${LIMITS.wakesPerPayload} wake requests per payload`);
      }
      if (others.length >= LIMITS.wakesPerBox) {
        throw new ProtocolError("limit_exceeded", `at most ${LIMITS.wakesPerBox} wake requests per box`);
      }
      const entry: WakeEntry = { payload, id, ...parsed };
      const next = [...others, entry];
      if (wakeRecordBytes(next, s.bootId, now) > LIMITS.wakesRecordBytes) {
        throw new ProtocolError("limit_exceeded", "the wake set would not fit in rec/wakes");
      }
      s.wakes = next;
      await persist();
      return wakeOf(entry);
    },
    deleteWake: (payload, id) => remove("wakes", payload, id),
    listWakes: (payload, now) =>
      byPayload(s.wakes, payload)
        .filter((w) => isLive(w.expiresAt, now))
        .map(wakeOf),

    putPresence: async (payload, id, input, now) => {
      const asked = Date.parse(input.until);
      if (!(asked > now)) throw new ProtocolError("invalid_value", "until must be in the future", { field: "until" });
      prune(now);
      const old = s.presence.find((p) => p.payload === payload && p.id === id);
      if (!old && s.presence.filter((p) => p.payload === payload).length >= LIMITS.presencePerPayload) {
        throw new ProtocolError("limit_exceeded", `at most ${LIMITS.presencePerPayload} presence entries per payload`);
      }
      const until = Math.min(asked, now + LIMITS.presenceMaxSeconds * 1000);
      const entry = { payload, id, kind: input.kind, until, label: input.label ?? null };
      s.presence = [...s.presence.filter((p) => p !== old), entry];
      if (input.kind === "interactive") s.lastInteractiveAt = Math.max(s.lastInteractiveAt ?? 0, now);
      await persist();
      return { id, kind: entry.kind, until: toInstant(until) };
    },
    deletePresence: (payload, id) => remove("presence", payload, id),

    beats: async (payload, beats, now) => {
      const mine = s.beats.filter((b) => b.payload === payload);
      const names = new Set(mine.map((b) => `${b.kind}/${b.name}`));
      const updates = beats.map((b, i) => {
        const at = b.at === undefined ? now : Date.parse(b.at);
        if (at < now - LIMITS.beatPastSeconds * 1000 || at > now + LIMITS.beatFutureSeconds * 1000) {
          throw new ProtocolError("invalid_value", "at must be within 5 minutes before and 5 seconds after now", {
            field: `beats[${i}].at`,
          });
        }
        if (b.kind === "progress" && b.expectEverySeconds !== undefined) {
          throw new ProtocolError("invalid_value", "expectEverySeconds is for loop beats", {
            field: `beats[${i}].expectEverySeconds`,
          });
        }
        names.add(`${b.kind}/${b.name}`);
        return { payload, kind: b.kind, name: b.name, at, expectEveryMs: (b.expectEverySeconds ?? 0) * 1000 || null };
      });
      if (names.size > LIMITS.beatNamesPerPayload) {
        throw new ProtocolError("limit_exceeded", `at most ${LIMITS.beatNamesPerPayload} beat names per payload`);
      }
      for (const u of updates) {
        const old = s.beats.find((b) => b.payload === payload && b.kind === u.kind && b.name === u.name);
        if (!old) s.beats.push(u);
        else if (u.at >= old.at) Object.assign(old, { at: u.at, expectEveryMs: u.expectEveryMs ?? old.expectEveryMs });
      }
      await persist();
    },
    beatsOf: (payload, now) => {
      const mine = s.beats.filter((b) => b.payload === payload);
      return {
        progress: Object.fromEntries(mine.filter((b) => b.kind === "progress").map((b) => [b.name, b.at])),
        missedLoops: mine
          .filter((b) => b.kind === "loop" && b.expectEveryMs !== null && now - b.at > b.expectEveryMs)
          .map((b) => b.name),
      };
    },

    putHealth: async (payload, input, now) => {
      const entry: HealthEntry = {
        payload,
        ok: input.ok,
        detail: input.detail ?? null,
        until: now + input.ttlSeconds * 1000,
      };
      s.health = [...s.health.filter((h) => h.payload !== payload), entry];
      await persist();
    },
    healthOf: (payload, now) => {
      const h = s.health.find((e) => e.payload === payload && isLive(e.until, now));
      return h ? { ok: h.ok, detail: h.detail } : null;
    },

    holds: async (now): Promise<ReadonlyArray<IdleHold>> =>
      s.holds
        .filter((h) => isLive(h.until, now))
        .map((h) => ({ key: `${h.payload}/${h.id}`, kind: h.kind, until: h.until })),
    presence: async (now): Promise<ReadonlyArray<IdlePresence>> =>
      s.presence
        .filter((p) => isLive(p.until, now))
        .map((p) => ({ key: presenceKey(p.payload, p.id), kind: p.kind, until: p.until })),
    lastProgressAt: async () => {
      const ats = s.beats.filter((b) => b.kind === "progress").map((b) => b.at);
      return ats.length === 0 ? null : Math.max(...ats);
    },
    lastInteractiveAt: async () => s.lastInteractiveAt,
    wakeRequests: async (): Promise<BoxWakeRequests> => s.wakes.map((w) => ({ payload: w.payload, ...wakeOf(w) })),
  };
  await chain;
  return store;
}
