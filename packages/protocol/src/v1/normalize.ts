// Tolerant readers (part 4 §4.15 rule 1): extra fields are allowed by the response schemas, and unknown enum
// values are mapped to the documented fallback before validation.
import { decode, isRecord, withFallback } from "../decode.ts";
import type { Severity } from "./common.ts";
import {
  CapReachedEvent,
  DiskEvent,
  EVENT_SCHEMAS,
  HoldClampedEvent,
  PhaseEvent,
  ReclaimNoticeEvent,
  SleepingEvent,
  type EventName,
} from "./events.ts";
import { PHASES, Status, type Phase } from "./status.ts";

/** Unknown `phase` reads as this. */
export const PHASE_FALLBACK: Phase = "serving";
/** Unknown `severity` reads as this. */
export const SEVERITY_FALLBACK: Severity = "notify";
const SEVERITIES: ReadonlyArray<Severity> = ["page", "notify", "info"];

export function normalizeSeverity(value: string): Severity {
  return (SEVERITIES as ReadonlyArray<string>).includes(value) ? (value as Severity) : SEVERITY_FALLBACK;
}

function withPhaseFallback(obj: Record<string, unknown>): Record<string, unknown> {
  return withFallback(obj, "phase", PHASES, PHASE_FALLBACK);
}

/** Decode a `GET /v1/status` body. Throws ProtocolDecodeError when it does not match after the fallbacks. */
export function normalizeStatus(raw: unknown): Status {
  let value = raw;
  if (isRecord(raw) && isRecord(raw["box"])) value = { ...raw, box: withPhaseFallback(raw["box"]) };
  return decode<Status>(Status, "Status", value);
}

export type ProtocolEvent =
  | ({ readonly type: "phase" } & PhaseEvent)
  | ({ readonly type: "reclaim-notice" } & ReclaimNoticeEvent)
  | ({ readonly type: "sleeping" } & SleepingEvent)
  | ({ readonly type: "disk" } & DiskEvent)
  | ({ readonly type: "hold-clamped" } & HoldClampedEvent)
  | ({ readonly type: "cap-reached" } & CapReachedEvent)
  | { readonly type: "ping" }
  | { readonly type: "unknown"; readonly name: string; readonly data: unknown };

function isEventName(name: string): name is EventName {
  return Object.hasOwn(EVENT_SCHEMAS, name);
}

/**
 * Decode one server-sent event by its `event` name and parsed `data`. An unknown name, or data that does not
 * match its schema after the fallbacks, becomes `{ type: "unknown" }`: a reader never throws on an event.
 */
export function normalizeEvent(name: string, data: unknown): ProtocolEvent {
  if (!isEventName(name)) return { type: "unknown", name, data };
  const value = name === "phase" && isRecord(data) ? withPhaseFallback(data) : data;
  try {
    const decoded = decode<Record<string, unknown>>(EVENT_SCHEMAS[name], name, value);
    return { ...decoded, type: name } as ProtocolEvent;
  } catch {
    return { type: "unknown", name, data };
  }
}
