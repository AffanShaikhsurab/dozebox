// The alert ledger policy: one ledger decides for every sender which alert is pushed. Ported without change of behaviour
// from the legacy control's `alertrouter.mjs` (admitAlert and its ledger helpers).
import { DAY, HOUR, MINUTE } from "../time/index.ts";

/** A key stays admitted this long: one episode raises one alert. */
export const EPISODE_MS = 12 * HOUR;
export const NOTICES_PER_HOUR = 6;
export const NOTICES_PER_DAY = 20;
/** Pages are exempt from the notice limits; this only stops a flood of distinct keys. */
export const PAGES_PER_HOUR_CEILING = 30;
export const ESCALATE_AFTER_MS = 10 * MINUTE;
const OPEN_PAGE_KEEP_MS = 3 * DAY;
const DAYS_KEPT = 30;
const MAX_KEYS = 40;
const MAX_PENDING = 10;

export type LedgerKey = { readonly at: number; readonly sev: "p" | "n"; readonly open?: 1 };
export type Pending = {
  readonly key: string;
  readonly text: string;
  readonly at: number;
  readonly [extra: string]: unknown;
};
export type Ledger = {
  readonly v: 1;
  readonly keys: Readonly<Record<string, LedgerKey>>;
  readonly notices: ReadonlyArray<number>;
  readonly pending: ReadonlyArray<Pending>;
  readonly days: Readonly<Record<string, readonly [number, number]>>;
};
export type AlertMessage = {
  readonly key: string;
  readonly severity: "page" | "notify" | "info";
  readonly text: string;
  readonly resolves?: ReadonlyArray<string>;
};
export type Admission = {
  readonly send: boolean;
  readonly why: "info" | "duplicate" | "rate-limited" | "notice" | "page-ceiling" | "page";
  readonly ledger: Ledger;
  readonly badge: number;
};

const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The daily counters after one push (and one page when `page`). */
const countPush = (days: Ledger["days"], nowMs: number, page: boolean): Ledger["days"] => {
  const day = dayKey(nowMs);
  const [pushes, pages] = days[day] ?? [0, 0];
  return { ...days, [day]: [pushes + 1, pages + (page ? 1 : 0)] };
};

export const emptyLedger = (): Ledger => ({ v: 1, keys: {}, notices: [], pending: [], days: {} });

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> => v !== null && typeof v === "object";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numbers = (list: unknown): number[] => (Array.isArray(list) ? list.filter(finite) : []);

/** Raw parameter text to a ledger; junk becomes an empty ledger, never a throw (a broken ledger must not stop alerts). */
export function parseLedger(raw: unknown): Ledger {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw ?? ""));
  } catch {
    return emptyLedger();
  }
  if (!isObject(parsed) || parsed["v"] !== 1) return emptyLedger();
  const keys: Record<string, LedgerKey> = {};
  for (const [key, entry] of Object.entries(isObject(parsed["keys"]) ? parsed["keys"] : {})) {
    if (isObject(entry) && finite(entry["at"]) && (entry["sev"] === "p" || entry["sev"] === "n"))
      keys[key] = { at: entry["at"], sev: entry["sev"], ...(entry["open"] === 1 ? { open: 1 as const } : {}) };
  }
  const pending = (Array.isArray(parsed["pending"]) ? parsed["pending"] : []).filter(
    (p): p is Pending =>
      isObject(p) && typeof p["key"] === "string" && finite(p["at"]) && typeof p["text"] === "string",
  );
  const days: Record<string, readonly [number, number]> = {};
  for (const [day, counts] of Object.entries(isObject(parsed["days"]) ? parsed["days"] : {}))
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Array.isArray(counts) && counts.every((n) => Number.isFinite(n)))
      days[day] = [counts[0] ?? 0, counts[1] ?? 0];
  return { v: 1, keys, notices: numbers(parsed["notices"]), pending, days };
}

/** Drops what no longer matters, so the ledger stays small. */
export function pruneLedger(ledger: Ledger, nowMs: number): Ledger {
  const keys: Record<string, LedgerKey> = {};
  const entries = Object.entries(ledger.keys)
    .filter(([, e]) => (e.open === 1 ? nowMs - e.at < OPEN_PAGE_KEEP_MS : nowMs - e.at < EPISODE_MS))
    .toSorted((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_KEYS);
  for (const [key, entry] of entries) keys[key] = entry;
  const oldestDay = dayKey(nowMs - DAYS_KEPT * DAY);
  const days = Object.fromEntries(Object.entries(ledger.days).filter(([day]) => day > oldestDay));
  return {
    v: 1,
    keys,
    notices: ledger.notices.filter((at) => nowMs - at < DAY),
    pending: ledger.pending.slice(-MAX_PENDING),
    days,
  };
}

/** Pages still waiting for a decision (the badge). */
export const openDecisions = (ledger: Ledger): number =>
  Object.values(ledger.keys).filter((e) => e.sev === "p" && e.open === 1).length;

/**
 * Returns the next ledger and whether to push the message. `info` is never pushed. A key already admitted within an
 * episode is a duplicate. Notices are held to 6 an hour and 20 a day; pages are exempt but deduped by key and capped
 * per hour. The caller writes `ledger` before it sends.
 */
export function admitAlert(ledger: Ledger, message: AlertMessage, nowMs: number): Admission {
  const current = pruneLedger(ledger, nowMs);
  let next = current;
  const resolves = message.resolves;
  if (Array.isArray(resolves) && resolves.length > 0) {
    const keys: Record<string, LedgerKey> = { ...next.keys };
    for (const key of resolves) {
      const k = keys[key];
      if (k?.open === 1) keys[key] = { at: k.at, sev: k.sev };
    }
    next = { ...next, keys, pending: next.pending.filter((p) => !resolves.includes(p.key)) };
  }
  const badge = openDecisions(next);
  if (message.severity === "info") return { send: false, why: "info", ledger: next, badge };
  const seen = next.keys[message.key];
  if (seen !== undefined && (seen.open === 1 || nowMs - seen.at < EPISODE_MS))
    return { send: false, why: "duplicate", ledger: next, badge };
  if (message.severity === "notify") {
    const lastHour = next.notices.filter((at) => nowMs - at < HOUR).length;
    if (lastHour >= NOTICES_PER_HOUR || next.notices.length >= NOTICES_PER_DAY)
      return { send: false, why: "rate-limited", ledger: next, badge };
    next = {
      ...next,
      notices: [...next.notices, nowMs],
      keys: { ...next.keys, [message.key]: { at: nowMs, sev: "n" } },
      days: countPush(next.days, nowMs, false),
    };
    return { send: true, why: "notice", ledger: pruneLedger(next, nowMs), badge };
  }
  const pagesThisHour = Object.values(next.keys).filter((e) => e.sev === "p" && nowMs - e.at < HOUR).length;
  if (pagesThisHour >= PAGES_PER_HOUR_CEILING) return { send: false, why: "page-ceiling", ledger: next, badge };
  next = {
    ...next,
    keys: { ...next.keys, [message.key]: { at: nowMs, sev: "p", open: 1 } },
    days: countPush(next.days, nowMs, true),
    pending: [...next.pending, { key: message.key, text: message.text, at: nowMs }],
  };
  next = pruneLedger(next, nowMs);
  return { send: true, why: "page", ledger: next, badge: openDecisions(next) };
}

/** Pushes and pages sent in the last `days` days, from the ledger's daily counters. */
export function pushAudit(ledger: Ledger, nowMs: number, days = DAYS_KEPT): { pushes: number; pages: number } {
  const oldest = dayKey(nowMs - days * DAY);
  let pushes = 0;
  let pages = 0;
  for (const [day, [p, g]] of Object.entries(ledger.days))
    if (day > oldest) {
      pushes += p;
      pages += g;
    }
  return { pushes, pages };
}
