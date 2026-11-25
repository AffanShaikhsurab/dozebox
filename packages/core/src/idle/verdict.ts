// The idle verdict (part 4 §4.16): one pure function shared by the agent and the simulator.

export type IdleHold = { readonly key: string; readonly kind: "work" | "wait"; readonly until: number };
export type IdlePresence = { readonly key: string; readonly kind: "interactive" | "viewing"; readonly until: number };

export type IdleInputs = {
  /** Epoch ms. */
  readonly now: number;
  /** idleMinutes * 60_000. */
  readonly idleMs: number;
  readonly viewingGraceMs: number;
  readonly servingSince: number | null;
  readonly holds: ReadonlyArray<IdleHold>;
  readonly presence: ReadonlyArray<IdlePresence>;
  readonly lastInteractiveAt: number | null;
  readonly lastProgressAt: number | null;
  /** Fallback activity for payloads in "health-only" mode. */
  readonly lastActivityAt: number | null;
};

/** `hold:<key>`, `presence:<key>` or `recent-activity`. */
export type AwakeReason = string;

export type IdleVerdict =
  | { readonly kind: "awake"; readonly because: ReadonlyArray<AwakeReason> }
  | { readonly kind: "idle"; readonly since: number; readonly sleepAt: number };

/**
 * Until when one presence entry counts as activity. Interactive presence counts until it expires. Viewing presence
 * counts only within the viewing grace after the last interactive input, so a tab left open does not keep the box
 * awake for ever.
 */
function presenceCountsUntil(p: IdlePresence, i: IdleInputs): number {
  if (p.kind === "interactive") return p.until;
  if (i.lastInteractiveAt === null) return 0;
  return Math.min(p.until, i.lastInteractiveAt + i.viewingGraceMs);
}

export function idleVerdict(i: IdleInputs): IdleVerdict {
  const because: AwakeReason[] = [];
  for (const h of i.holds) if (h.until > i.now) because.push(`hold:${h.key}`);
  for (const p of i.presence) {
    if (p.until > i.now && presenceCountsUntil(p, i) > i.now) because.push(`presence:${p.key}`);
  }
  if (because.length > 0) return { kind: "awake", because };

  const last = Math.max(
    i.servingSince ?? 0,
    i.lastInteractiveAt ?? 0,
    i.lastProgressAt ?? 0,
    i.lastActivityAt ?? 0,
    ...i.holds.map((h) => h.until),
    ...i.presence.map((p) => presenceCountsUntil(p, i)),
  );
  const sleepAt = last + i.idleMs;
  if (sleepAt > i.now) return { kind: "awake", because: ["recent-activity"] };
  return { kind: "idle", since: last, sleepAt };
}
