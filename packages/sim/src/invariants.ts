// S2: the protocol invariants of part 9 §9.2 checked over a simulated trace (holds, beats, presence, wakes).
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

export function checkInvariants(_trace: ReadonlyArray<TraceEvent>): ReadonlyArray<Violation> {
  throw new Error("not implemented: S2 checkInvariants");
}
