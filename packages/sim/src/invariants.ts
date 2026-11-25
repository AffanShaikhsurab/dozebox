// S2: the protocol invariants of part 9 §9.3 over the protocol trace of one simulated day: what the payload asked for
// (holds, presence, beats, wake requests) against what the agent did (its parks) and what came of it (wakes, boots).
// Pure: the trace in, the violations out. Trace keys: holds `work:<id>` or `wait:<id>`, presence `interactive:<id>` or
// `viewing:<id>`, wake requests `wake:<id>` with `until` = the requested time; a `release` with the same key ends a hold
// or cancels a wake request; `park` ends a boot (`until` = when that boot started; key = the agent's reason, or
// `down` when the instance went away under it); `serving` starts a boot.
export type TraceEvent = {
  readonly at: number;
  readonly kind: "hold" | "release" | "beat" | "presence" | "wake-request" | "park" | "wake" | "serving";
  readonly key?: string;
  readonly until?: number;
};

export type InvariantId =
  | "no-park-while-held"
  | "no-park-while-present"
  | "wake-request-honoured"
  | "progress-or-park"
  | "holds-cleared-on-boot"
  | "one-park-per-boot";

export type Violation = { readonly id: InvariantId; readonly at: number; readonly detail: string };

const MINUTE = 60_000;
/** The simulator's `noProgressParkMinutes`. */
export const NO_PROGRESS_MS = 120 * MINUTE;
const SLACK_MS = 15 * MINUTE;
/** A park's stop takes a minute or two; a repeat inside this window is the same park. */
const SAME_PARK_MS = 2 * MINUTE;

type Live = { readonly key: string; until: number };

const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
const isWork = (key: string): boolean => !key.startsWith("wait:");
const isInteractive = (key: string): boolean => !key.startsWith("viewing:");

export function checkInvariants(trace: ReadonlyArray<TraceEvent>): ReadonlyArray<Violation> {
  const out: Violation[] = [];
  const fail = (id: InvariantId, at: number, detail: string): void => {
    if (!out.some((v) => v.id === id)) out.push({ id, at, detail });
  };
  const holds = new Map<string, Live>();
  const presence = new Map<string, Live>();
  const requests = new Map<string, Live>();
  const owed: Array<{ readonly key: string; readonly at: number; readonly parkedAt: number }> = [];
  const wakes: number[] = [];
  let bootAt: number | null = null;
  let before = new Map<string, number>();
  let parks: Array<{ readonly at: number; readonly boot: number }> = [];
  let progressAt = 0;

  /** Work holds and interactive presence count as progress until they end. */
  const advance = (t: number): void => {
    for (const h of holds.values()) if (isWork(h.key)) progressAt = Math.max(progressAt, Math.min(h.until, t));
    for (const p of presence.values())
      if (isInteractive(p.key)) progressAt = Math.max(progressAt, Math.min(p.until, t));
    if (bootAt !== null && t - progressAt > NO_PROGRESS_MS + SLACK_MS)
      fail("progress-or-park", t, `serving with no progress since ${clock(progressAt)}, still up at ${clock(t)}`);
  };
  const liveHold = (t: number): Live | undefined => [...holds.values()].find((h) => h.until > t);

  for (const e of trace) {
    advance(e.at);
    const key = e.key ?? "";
    const until = e.until ?? e.at;
    switch (e.kind) {
      case "serving":
        before = new Map([...holds.values()].map((h) => [h.key, h.until]));
        holds.clear();
        presence.clear();
        bootAt = e.at;
        parks = [];
        progressAt = e.at;
        break;
      case "hold":
        if (bootAt !== null && e.at - bootAt < MINUTE && before.get(key) === until)
          fail("holds-cleared-on-boot", e.at, `${key} from the boot before came back unrenewed at ${clock(e.at)}`);
        holds.set(key, { key, until });
        break;
      case "release": {
        const h = holds.get(key);
        if (h !== undefined) h.until = Math.min(h.until, e.at);
        requests.delete(key);
        break;
      }
      case "presence":
        presence.set(key, { key, until });
        break;
      case "beat":
        progressAt = e.at;
        break;
      case "wake-request":
        requests.set(key, { key, until });
        break;
      case "wake":
        wakes.push(e.at);
        break;
      case "park": {
        const h = liveHold(e.at);
        if (key === "idle" && h !== undefined)
          fail(
            "no-park-while-held",
            e.at,
            `parked (idle) at ${clock(e.at)} while ${h.key} was held until ${clock(h.until)}`,
          );
        if (
          (key === "idle" || key === "no-progress") &&
          [...presence.values()].some((p) => isInteractive(p.key) && p.until > e.at)
        )
          fail("no-park-while-present", e.at, `parked (${key}) at ${clock(e.at)} while a person was present`);
        const boot = e.until;
        if (boot !== undefined && parks.some((p) => p.boot === boot && e.at - p.at > SAME_PARK_MS))
          fail("one-park-per-boot", e.at, `a second park at ${clock(e.at)} of the boot from ${clock(boot)}`);
        if (boot !== undefined) parks.push({ at: e.at, boot });
        for (const r of requests.values()) if (r.until > e.at) owed.push({ key: r.key, at: r.until, parkedAt: e.at });
        requests.clear();
        bootAt = null;
        break;
      }
    }
  }
  const end = trace.at(-1)?.at ?? 0;
  advance(end);
  /** The box was up at `t`: its newest boot or park before `t` is a boot. */
  const upAt = (t: number): boolean =>
    trace.filter((x) => x.at <= t && (x.kind === "serving" || x.kind === "park")).at(-1)?.kind === "serving";
  for (const o of owed) {
    if (end < o.at + 30 * MINUTE) continue;
    const woken = wakes.some((t) => t >= o.at - MINUTE && t <= o.at + 30 * MINUTE) || upAt(o.at);
    if (!woken)
      fail(
        "wake-request-honoured",
        o.at,
        `${o.key} for ${clock(o.at)}, live at the park at ${clock(o.parkedAt)}: no wake`,
      );
  }
  return out;
}
