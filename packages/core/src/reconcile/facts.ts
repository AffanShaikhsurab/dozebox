// The facts the legacy-shaped reconcile reads from one snapshot of AWS and the records, and the small helpers every
// rule shares. Ported from the legacy control's `common.mjs`, `records.mjs` and `model.mjs` header. Times in a
// snapshot are ISO strings, as the AWS APIs give them; `nowMs` is epoch ms.
import { MINUTE } from "../time/index.ts";

export type Iso = string;

export type PersistentFacts = {
  readonly id: string;
  readonly state: string;
  readonly launchedAt?: Iso | null | undefined;
  readonly stateReasonCode?: string | null | undefined;
  readonly stateTransitionReason?: string | null | undefined;
  readonly [extra: string]: unknown;
};
export type SpotRequestFacts = {
  readonly state?: string | null | undefined;
  readonly statusCode?: string | null | undefined;
  readonly statusUpdatedAt?: Iso | null | undefined;
};
export type VolumeFacts = {
  readonly id?: string | undefined;
  readonly attachedTo?: string | null | undefined;
  readonly attachmentState?: string | null | undefined;
  readonly [extra: string]: unknown;
};
export type AsgInstanceFacts = {
  readonly id: string;
  readonly lifecycleState?: string | undefined;
  readonly [extra: string]: unknown;
};
export type AsgFacts = {
  readonly desired?: number | undefined;
  readonly onDemandPercent?: number | undefined;
  readonly instances?: ReadonlyArray<AsgInstanceFacts> | undefined;
  readonly od?: { readonly desired?: number | undefined } | undefined;
  readonly [extra: string]: unknown;
};
export type AsgStatusFacts = {
  readonly state?: string | undefined;
  readonly desired?: number | undefined;
  readonly since?: Iso | null | undefined;
  readonly instance?: { readonly id: string; readonly launchedAt?: Iso | null | undefined } | null | undefined;
  readonly [extra: string]: unknown;
};
export type IntentFacts = { readonly at: Iso; readonly fallbackReason: string | null };
export type InstanceRecord = { readonly instanceId?: string | undefined; readonly at?: Iso | null | undefined };

export type Snapshot = {
  readonly nowMs: number;
  readonly persistent?: PersistentFacts | null | undefined;
  readonly persistents?: ReadonlyArray<PersistentFacts> | undefined;
  readonly spotRequest?: SpotRequestFacts | null | undefined;
  readonly volume?: VolumeFacts | null | undefined;
  readonly asg?: AsgFacts | null | undefined;
  readonly asgStatus?: AsgStatusFacts | null | undefined;
  readonly asgLive?: boolean | undefined;
  readonly asgParkedAt?: Iso | null | undefined;
  readonly asgLastLaunchAt?: Iso | null | undefined;
  readonly intent?: IntentFacts | null | undefined;
  readonly serving?: InstanceRecord | null | undefined;
  readonly bootTimeline?: InstanceRecord | null | undefined;
  readonly rolledBack?: unknown;
  readonly lastError?: unknown;
  readonly boxError?: unknown;
  /** The time (ms) of the newest sleep fence, written by every sleep even when it stops nothing (R2). */
  readonly sleepFenceMs?: number | null | undefined;
  readonly nextWakeAt?: number | null | undefined;
  readonly startError?: unknown;
  readonly [extra: string]: unknown;
};

/** A box that was reclaimed counts as "replacing" for this long after the interruption. */
export const REPLACING_WINDOW_MS = 15 * MINUTE;
/** A machine that launches this soon after a wake request is the one that wake started. */
export const WAKE_LAUNCH_WINDOW_MS = 10 * MINUTE;

export function timeMs(iso: unknown): number | null {
  const ms = Date.parse(String(iso ?? ""));
  return Number.isNaN(ms) ? null : ms;
}
export const isoOf = (ms: number): Iso => new Date(ms).toISOString();

export const isInService = (i: AsgInstanceFacts): boolean => i.lifecycleState === "InService";
export const isPending = (i: AsgInstanceFacts): boolean =>
  typeof i.lifecycleState === "string" && i.lifecycleState.startsWith("Pending");
export const isLive = (i: AsgInstanceFacts): boolean => isInService(i) || isPending(i);
export const isLiveState = (state: unknown): boolean => state === "pending" || state === "running";

/**
 * `StateTransitionReason` of a user stop: "User initiated (2026-11-12 09:23:07 GMT)". An ISO string, or null when
 * there is no timestamp (interruptions have none).
 */
export function parseStoppedAt(reason: unknown): Iso | null {
  const match = /\((\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) GMT\)/.exec(String(reason ?? ""));
  if (!match) return null;
  const ms = Date.parse(`${match[1]}T${match[2]}Z`);
  return Number.isNaN(ms) ? null : isoOf(ms);
}
