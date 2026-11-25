// A5: the park sequence. Order matters (part 3 §3.4): last words, wakes at park, the fence, stop payloads, stop self.
// Records come first so the control function can tell why the box slept and when to wake it even if the stop call
// is the last thing this boot does. A failed record write is logged and the park goes on: a box that cannot write
// to SSM must still stop costing money. Only the stop call itself is retried, and a park that could not stop the
// machine puts the phase back so a later tick may try again.
import type { Clock } from "@dozebox/core/time";
import type { ErrorLog } from "../errors.ts";
import { canPark, type ParkReason, type PhaseCell } from "../phase.ts";
import type { HoldSource } from "../ports/holds.ts";
import type { Logger } from "../ports/log.ts";
import type { PayloadSupervisor } from "../ports/payloads.ts";
import type { SelfStop, SelfStopTarget } from "../ports/selfstop.ts";
import type { RecordPublisher } from "../records/publish.ts";

export type ParkDeps = {
  readonly clock: Clock;
  /** `rec/last-words`, `rec/wakes`, `fence/sleep-requested`. */
  readonly records: Pick<RecordPublisher, "put">;
  readonly errors: Pick<ErrorLog, "recent" | "add">;
  readonly holds: HoldSource;
  readonly payloads: Pick<PayloadSupervisor, "stopAll">;
  readonly selfStop: SelfStop;
  readonly target: SelfStopTarget;
  readonly phase: PhaseCell;
  readonly log: Logger;
  /** Health strikes at the moment of the park (watchdog), for last words. */
  readonly strikes?: () => number;
};

/** Payloads get this long to stop before the stop call goes out anyway. */
export const PAYLOAD_STOP_MS = 60_000;
export const STOP_ATTEMPTS = 3;
export const STOP_RETRY_MS = 10_000;

export type ParkOutcome = "parked" | "already-parking";

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Park the box. A park while another park or a reclaim runs is refused ("already-parking"), except that the reclaim
 * itself (reason "reclaim" during "reclaim-notice") goes through. Rejects only when the stop call failed every time.
 */
export async function park(deps: ParkDeps, reason: ParkReason, detail: string): Promise<ParkOutcome> {
  const log = deps.log.child({ component: "park" });
  const before = deps.phase.get();
  const reclaim = reason === "reclaim" && before.phase === "reclaim-notice";
  if (!canPark(before) && !reclaim) {
    log.log("info", "park refused: already parking", { reason, phase: before.phase });
    return "already-parking";
  }
  const now = deps.clock.now();
  deps.phase.set({ phase: "sleeping", since: now, reason });
  log.log("info", "parking", { reason, detail });

  const write = async (what: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      deps.errors.add(`park:${what}`, e);
      log.log("error", `park: could not write ${what}`, { error: e });
    }
  };

  const holds = await deps.holds.holds(now).catch(() => []);
  const presence = await deps.holds.presence(now).catch(() => []);
  const awakeBecause = [...holds.map((h) => `hold:${h.key}`), ...presence.map((p) => `presence:${p.key}`)];
  await write("rec/last-words", () =>
    deps.records.put("rec/last-words", {
      parkedBecause: reason,
      by: "agent",
      detail: cut(detail, 300),
      recentErrors: deps.errors.recent(3).map((e) => cut(`${e.source}: ${e.message}`, 300)),
      strikes: deps.strikes?.() ?? 0,
      awakeBecause: awakeBecause.slice(0, 10),
    }),
  );
  await write("rec/wakes", async () =>
    deps.records.put("rec/wakes", { atPark: true, wakes: [...(await deps.holds.wakeRequests())] }),
  );
  await write("fence/sleep-requested", () =>
    deps.records.put("fence/sleep-requested", { reason, phase: "before-stop" }),
  );

  try {
    await deps.payloads.stopAll(deps.clock.timeout(PAYLOAD_STOP_MS));
  } catch (e) {
    deps.errors.add("park:payloads", e);
    log.log("error", "park: payloads did not stop cleanly", { error: e });
  }

  for (let attempt = 1; ; attempt++) {
    try {
      await deps.selfStop.stopSelf(deps.target);
      break;
    } catch (e) {
      deps.errors.add("park:stop", e);
      log.log("error", "park: stop call failed", { error: e, attempt });
      if (attempt >= STOP_ATTEMPTS) {
        deps.phase.set(before);
        throw e;
      }
      await deps.clock.sleep(STOP_RETRY_MS);
    }
  }
  await write("fence/sleep-requested", () =>
    deps.records.put("fence/sleep-requested", { reason, phase: "after-stop" }),
  );
  return "parked";
}
