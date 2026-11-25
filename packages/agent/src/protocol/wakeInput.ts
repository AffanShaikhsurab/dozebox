// A2: the semantic rules of a wake request (part 4 §4.8) after its schema check.
import type { WakeInput, WakeMatch } from "@dozebox/protocol/v1";
import { ProtocolError } from "./errors.ts";
import { LIMITS, WAKE_AT_EXPIRY_MS, WAKE_EVENT_EXPIRY_MS } from "./limits.ts";

export type ParsedWake = {
  readonly reason: string;
  readonly at?: number;
  readonly on?: WakeMatch;
  readonly expiresAt: number;
};

/** An `at` in the past is accepted ("as soon as possible"); an `at` past the horizon or a past expiry is refused. */
export function parseWakeInput(input: WakeInput, now: number): ParsedWake {
  if (input.at === undefined && input.on === undefined) {
    throw new ProtocolError("invalid_value", "a wake request needs at or on", { field: "at" });
  }
  const at = input.at === undefined ? undefined : Date.parse(input.at);
  if (at !== undefined && at > now + LIMITS.wakeHorizonSeconds * 1000) {
    throw new ProtocolError("invalid_value", `at is more than ${LIMITS.wakeHorizonSeconds} seconds ahead`, {
      field: "at",
    });
  }
  const byAt = at === undefined ? 0 : at + WAKE_AT_EXPIRY_MS;
  const byEvent = input.on === undefined ? 0 : now + WAKE_EVENT_EXPIRY_MS;
  const expiresAt = input.expiresAt === undefined ? Math.max(byAt, byEvent) : Date.parse(input.expiresAt);
  if (!(expiresAt > now)) {
    throw new ProtocolError("invalid_value", "expiresAt must be in the future", {
      field: input.expiresAt === undefined ? "at" : "expiresAt",
    });
  }
  return {
    reason: input.reason,
    ...(at === undefined ? {} : { at }),
    ...(input.on === undefined ? {} : { on: input.on }),
    expiresAt,
  };
}
