// A2: the protocol's in-memory state with atomic JSON persistence under `/data/dozebox/protocol.json`. Holds and wakes
// survive an agent restart within one boot; a new boot id clears them. Implements HoldSource for the idle loop (A5).
import type { Beat, Hold, HoldInput, Presence, PresenceInput, Wake, WakeInput } from "@dozebox/protocol/v1";
import type { Files } from "../ports/files.ts";
import type { HoldSource } from "../ports/holds.ts";

export interface ProtocolStore extends HoldSource {
  /** Every key is `<payload>/<id>`. Clamps `until` to the hold cap and reports it (`hold-clamped`). */
  readonly putHold: (payload: string, id: string, input: HoldInput, now: number) => Promise<Hold>;
  readonly deleteHold: (payload: string, id: string) => Promise<boolean>;
  readonly listHolds: (payload: string | null, now: number) => ReadonlyArray<Hold>;
  readonly putWake: (payload: string, id: string, input: WakeInput, now: number) => Promise<Wake>;
  readonly deleteWake: (payload: string, id: string) => Promise<boolean>;
  readonly listWakes: (payload: string | null, now: number) => ReadonlyArray<Wake>;
  readonly putPresence: (payload: string, id: string, input: PresenceInput, now: number) => Promise<Presence>;
  readonly beats: (payload: string, beats: ReadonlyArray<Beat>, now: number) => Promise<void>;
}

export function makeProtocolStore(_deps: {
  readonly files: Files;
  readonly path: string;
  readonly bootId: string;
}): Promise<ProtocolStore> {
  throw new Error("not implemented: A2 makeProtocolStore");
}
