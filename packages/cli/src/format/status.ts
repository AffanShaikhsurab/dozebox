// Human lines for a ControlStatus (`status`, `wake`) and for the admin `status` records answer.
import type { ControlStatus } from "@dozebox/protocol/control";
import { ageMs, parseInstant } from "@dozebox/core/time";

const hours = (h: number): string => h.toFixed(1);
const usd = (n: number): string => `$${n.toFixed(2)}`;

/** `2026-11-25 00:00 UTC` from an Instant. */
function clockText(instant: string): string {
  return `${instant.slice(0, 10)} ${instant.slice(11, 16)} UTC`;
}

function ageText(ms: number | null): string {
  if (ms === null) return "unknown";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export function statusLines(s: ControlStatus): ReadonlyArray<string> {
  const lines = [
    `${s.box}: ${s.state} since ${clockText(s.since)} (desired ${s.desired})${s.frozen ? ", FROZEN" : ""}`,
    `${s.summary.headline} ${s.summary.detail}`.trim(),
  ];
  if (s.summary.next !== "") lines.push(`Next: ${s.summary.next}`);
  if (s.instance !== undefined) {
    const i = s.instance;
    lines.push(`Instance: ${i.id} ${i.type} ${i.lifecycle} in ${i.az}, launched ${clockText(i.launchedAt)}`);
  }
  if (typeof s.servingSince === "string") lines.push(`Serving since ${clockText(s.servingSince)}`);
  const c = s.caps;
  const awakeCap = c.awakeHoursCap === null ? "no cap" : `${hours(c.awakeHoursCap)} h`;
  const spend = c.monthSpendUsd === null ? "unknown" : usd(c.monthSpendUsd);
  lines.push(
    `Caps: awake ${hours(c.awakeHoursToday)} h of ${awakeCap} today, On-Demand ${hours(c.onDemandHoursToday)} h of ` +
      `${hours(c.onDemandHoursCap)} h, spend ${spend} of ${usd(c.monthBudgetUsd)} this month`,
  );
  lines.push(`Alert path: ${s.alertPath.level}${s.alertPath.say === undefined ? "" : ` (${s.alertPath.say})`}`);
  if (s.lastError !== undefined) lines.push(`Last error: ${s.lastError.message} (${s.lastError.source})`);
  if (s.lastWords !== undefined) lines.push(`Last park: ${s.lastWords.parkedBecause}: ${s.lastWords.detail}`);
  if (s.nextWake !== undefined) lines.push(`Next wake: ${clockText(s.nextWake.at)} for ${s.nextWake.payload}`);
  for (const a of s.summary.actions) lines.push(`Action: ${a}`);
  return lines;
}

export type RecordRow = { readonly key: string; readonly at: number | null; readonly writer: string | null };

/** Tolerant read of the admin `status` answer: `{ records: [{ key, at?, writer? }] }`; anything else is no rows. */
export function recordRows(answer: unknown): ReadonlyArray<RecordRow> {
  if (typeof answer !== "object" || answer === null) return [];
  const records = (answer as { readonly records?: unknown }).records;
  if (!Array.isArray(records)) return [];
  const rows: RecordRow[] = [];
  for (const r of records as ReadonlyArray<unknown>) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as { readonly key?: unknown; readonly at?: unknown; readonly writer?: unknown };
    if (typeof o.key !== "string") continue;
    rows.push({ key: o.key, at: parseInstant(o.at), writer: typeof o.writer === "string" ? o.writer : null });
  }
  return rows.toSorted((a, b) => a.key.localeCompare(b.key));
}

export function recordLines(rows: ReadonlyArray<RecordRow>, now: number): ReadonlyArray<string> {
  if (rows.length === 0) return ["No records."];
  const width = Math.max(...rows.map((r) => r.key.length));
  return rows.map((r) => `${r.key.padEnd(width)}  ${ageText(ageMs(now, r.at)).padStart(7)}  ${r.writer ?? "-"}`);
}
