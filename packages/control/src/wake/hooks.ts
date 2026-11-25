// C5: the hook route body: verify, read `rec/wakes` (falling back to `github-waits`), match, dedupe, write the wake
// intent with origin `event`. Answers 202 after the match; the reconcile tick does the slow work.
import type { HookRequest, BoxWakes, WakeSource } from "../ports/wakeSource.ts";

export type HookAnswer =
  | { readonly status: 202; readonly body: { readonly wake: boolean; readonly why: string } }
  | { readonly status: 401 | 404 | 413; readonly body: { readonly error: { readonly code: string } } };

export type HookDeps = {
  readonly sources: ReadonlyArray<WakeSource>;
  readonly wakes: () => Promise<BoxWakes>;
  /** Idempotency on `dedupeKey`: true the first time a key is seen. */
  readonly firstDelivery: (dedupeKey: string) => Promise<boolean>;
  /** Record desired = awake with origin `event` (decideWake decides; the route never calls Compute). */
  readonly requestWake: (why: string, wakeIds: ReadonlyArray<string>) => Promise<void>;
  readonly now: () => number;
};

export function handleHook(_deps: HookDeps, _req: HookRequest): Promise<HookAnswer> {
  throw new Error("not implemented: C5 handleHook");
}
