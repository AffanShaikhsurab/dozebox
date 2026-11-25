import { DozeboxCliError } from "./command.ts";

const DURATION = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
const UNIT_MS = [3_600_000, 60_000, 1_000] as const;

/** "2h", "15m", "90s", "1h30m" -> milliseconds. Anything else, or zero, is a usage error. */
export function parseDuration(text: string): number {
  const m = DURATION.exec(text);
  const ms = m ? UNIT_MS.reduce((sum, unit, i) => sum + Number(m[i + 1] ?? 0) * unit, 0) : 0;
  if (!m || text === "" || ms <= 0) {
    throw new DozeboxCliError("usage", `bad duration "${text}": use forms like 90s, 15m, 2h or 1h30m`);
  }
  return ms;
}
