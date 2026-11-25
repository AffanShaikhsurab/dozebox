// A8: the payload jail (part 8 §8.4, §8.5): bubblewrap profile and `dozebox jail exec`, AppArmor profile, per-uid
// nftables egress (`imds-only` or `allowlist`), and the tripwire (decoy profile, socket, report).
import type { Exec } from "../ports/exec.ts";
import type { Files } from "../ports/files.ts";

export type EgressMode = "imds-only" | "allowlist";

export type JailConfig = {
  readonly enabled: boolean;
  readonly egress: EgressMode;
  readonly allowHosts: ReadonlyArray<string>;
};

/** Pure: the argv prefix that runs a payload command inside the jail (empty when the jail is off). */
export function jailArgv(_cfg: JailConfig, _payload: string, _uid: number): ReadonlyArray<string> {
  throw new Error("not implemented: A8 jailArgv");
}

/** Pure: the nftables ruleset text for the payload uids. */
export function renderNftRules(
  _cfg: JailConfig,
  _uids: ReadonlyArray<number>,
  _resolved: ReadonlyArray<string>,
): string {
  throw new Error("not implemented: A8 renderNftRules");
}

/** Load the ruleset with `nft -f`; refuses to start payloads when loading fails (fail closed). */
export function applyEgress(
  _deps: { readonly exec: Exec; readonly files: Files },
  _rules: string,
  _signal: AbortSignal,
): Promise<void> {
  throw new Error("not implemented: A8 applyEgress");
}

export type TripwireHit = { readonly at: number; readonly what: "decoy-key" | "decoy-socket"; readonly detail: string };

export interface Tripwire {
  readonly arm: () => Promise<void>;
  /** Hits since the last call; each pages with context. */
  readonly hits: () => Promise<ReadonlyArray<TripwireHit>>;
}

export function makeTripwire(_deps: { readonly files: Files; readonly now: () => number }): Tripwire {
  throw new Error("not implemented: A8 makeTripwire");
}
