// C6: the outside judge, run by every tick inside the lease: wake failure (R3: a wake that does not serve in 15 min),
// silent box (a serving box whose liveness is older than 12 min), no-progress park from generic liveness (core
// decideNoProgress). It owns the `wake-breaker` key of C1's `state/keys.ts` and writes desired = asleep with origin
// `judge`. Each finding pages or notifies once: `marks` remembers which wake and which serving period were judged.
import type { Desired } from "@dozebox/core/reconcile";
import { readRecord } from "@dozebox/core/records";
import { MINUTE } from "@dozebox/core/time";
import { decideNoProgress, NEW_WAKE_BREAKER, onWakeEnd, type WakeBreaker } from "@dozebox/core/wake";
import type { AlertRouter } from "../alerts/index.ts";
import type { Alert } from "../ports/alertSink.ts";
import type { RecordStore } from "../ports/records.ts";

/** R3: a wake neither serving nor failed this long after acceptance has failed. */
export const WAKE_UNRESOLVED_MS = 15 * MINUTE;
/** A serving box that has not written liveness for this long is silent. */
export const SILENT_AFTER_MS = 12 * MINUTE;

export type JudgeVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "wake-unresolved"; readonly sinceMs: number }
  | { readonly kind: "silent"; readonly lastSeenAt: number | null }
  | { readonly kind: "no-progress-park"; readonly idleForMs: number };

/** What was already judged: the wake (by its `since`) and the serving period (by its serving time). */
export type JudgeMarks = {
  readonly unresolvedWake: number | null;
  readonly servedWake: number | null;
  readonly silentServing: number | null;
};
export const NO_MARKS: JudgeMarks = { unresolvedWake: null, servedWake: null, silentServing: null };

export type JudgeDeps = {
  readonly clock: { readonly now: () => number };
  readonly records: RecordStore;
  /** C1's DesiredStore satisfies it. */
  readonly desired: {
    readonly read: () => Promise<Desired>;
    readonly write: (d: Desired) => Promise<"written" | "older">;
  };
  readonly breaker: {
    readonly read: () => Promise<WakeBreaker | null>;
    readonly write: (b: WakeBreaker, token: number) => Promise<void>;
  };
  readonly marks: {
    readonly read: () => Promise<JudgeMarks>;
    readonly write: (m: JudgeMarks, token: number) => Promise<void>;
  };
  readonly alerts: Pick<AlertRouter, "submit">;
  readonly noProgressParkMs: number;
};

export interface OutsideJudge {
  /** Judge once; pages and parks when the verdict says so. */
  readonly run: (token: number) => Promise<JudgeVerdict>;
}

const ms = (iso: string | null | undefined): number | null => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : null;
};

const alert = (
  id: string,
  key: string,
  severity: Alert["severity"],
  title: string,
  body: string,
  now: number,
): Alert => ({
  id,
  key,
  severity,
  title,
  body,
  source: "runner:judge",
  at: now,
});

export function makeOutsideJudge(deps: JudgeDeps): OutsideJudge {
  return {
    run: async (token) => {
      const now = deps.clock.now();
      const desired = await deps.desired.read();
      if (desired.want !== "awake") return { kind: "ok" };
      const [serving, liveness, stored, marks] = await Promise.all([
        deps.records.get("rec/serving"),
        deps.records.get("rec/liveness"),
        deps.breaker.read(),
        deps.marks.read(),
      ]);
      const breaker = stored ?? NEW_WAKE_BREAKER;
      const s = readRecord("rec/serving", serving?.value ?? null, null);
      const l = readRecord("rec/liveness", liveness?.value ?? null, null);
      const servingAt = s.kind === "ok" ? ms(s.record.at) : null;
      const live = l.kind === "ok" ? l.record : null;
      const livenessAt = live === null ? null : ms(live.at);

      if (servingAt === null || servingAt < desired.since) {
        if (now - desired.since < WAKE_UNRESOLVED_MS || marks.unresolvedWake === desired.since) return { kind: "ok" };
        const next = onWakeEnd(breaker, "unresolved", now);
        await deps.breaker.write(next.breaker, token);
        await deps.marks.write({ ...marks, unresolvedWake: desired.since }, token);
        const title = "The box did not wake";
        const body = `A wake accepted ${Math.round((now - desired.since) / MINUTE)} min ago has not served.`;
        await deps.alerts.submit(
          alert(`wake-unresolved:${desired.since}`, "wake-unresolved", "page", title, body, now),
          token,
        );
        return { kind: "wake-unresolved", sinceMs: now - desired.since };
      }

      if (marks.servedWake !== desired.since) {
        if (breaker.failuresInRow > 0) await deps.breaker.write(onWakeEnd(breaker, "served", now).breaker, token);
        await deps.marks.write({ ...marks, servedWake: desired.since }, token);
      }

      const lastSeen = Math.max(servingAt, livenessAt ?? 0);
      if (now - lastSeen >= SILENT_AFTER_MS) {
        if (marks.silentServing !== servingAt) {
          await deps.marks.write({ ...marks, servedWake: desired.since, silentServing: servingAt }, token);
          const body = `No liveness from the box for ${Math.round((now - lastSeen) / MINUTE)} min.`;
          await deps.alerts.submit(
            alert(`box-silent:${servingAt}`, "box-silent", "page", "The box is silent", body, now),
            token,
          );
        }
        return { kind: "silent", lastSeenAt: livenessAt };
      }

      if (live === null) return { kind: "ok" };
      const progress = live.payloads.map((p) => ms(p.lastProgressAt)).filter((t): t is number => t !== null);
      const decision = decideNoProgress({
        now,
        noProgressMs: deps.noProgressParkMs,
        servingSince: servingAt,
        lastProgressAt: progress.length > 0 ? Math.max(...progress) : null,
        workHold: live.payloads.some((p) => p.holds.work > 0),
        interactive: (ms(live.presence.interactiveUntil) ?? 0) > now,
      });
      if (decision.kind !== "park") return { kind: "ok" };
      const park: Desired = { want: "asleep", since: now, reason: "park:no-progress", origin: "judge" };
      if ((await deps.desired.write(park)) === "written") {
        const body = `No progress for ${Math.round((now - decision.quietSince) / MINUTE)} min; parked.`;
        await deps.alerts.submit(
          alert(`no-progress:${now}`, "no-progress", "notify", "Parked: no progress", body, now),
          token,
        );
      }
      return { kind: "no-progress-park", idleForMs: now - decision.quietSince };
    },
  };
}
