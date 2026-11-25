// Plugin point 3 (part 5 §5.6): an outside event that may wake the box. Built-ins: github, generic (C5).
import type { RecordTypes } from "@dozebox/core/records";

/** The wake requests the box left in `rec/wakes`. */
export type BoxWakes = RecordTypes["rec/wakes"]["wakes"];

export type HookRequest = {
  readonly method: string;
  readonly path: string;
  /** Lower-case names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: Uint8Array;
};

export type WakeMatch =
  | {
      readonly wake: true;
      readonly why: string;
      /** `<payload>/<id>` of every wake request that matched. */
      readonly wakeIds: ReadonlyArray<string>;
      /** Delivery id, deduplicated for 24 h (`github:<X-GitHub-Delivery>`). */
      readonly dedupeKey: string;
    }
  | { readonly wake: false; readonly why: string };

export interface WakeSource {
  /** `github`, `generic`. */
  readonly id: string;
  /** `POST /v1/hooks/github`; `generic` matches the prefix `/v1/hooks/generic/`. */
  readonly route: { readonly method: "POST"; readonly path: string };
  /** Constant-time signature check. False: 401, nothing else runs. */
  readonly verify: (req: HookRequest, now: number) => Promise<boolean>;
  /** Pure: does this event match any wake request the box left? */
  readonly match: (req: HookRequest, wakes: BoxWakes, now: number) => WakeMatch;
}
