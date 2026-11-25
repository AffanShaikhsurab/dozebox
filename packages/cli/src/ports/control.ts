// The control function as the CLI sees it: the control API v1 over HTTPS (wake token in `x-dozebox-token`) and admin
// events over `lambda invoke` (operator IAM). Fake: testkit `makeFakeControlApi`.
import type { ControlStatus } from "@dozebox/protocol/control";

export type WakeAnswer =
  | { readonly kind: "accepted"; readonly status: ControlStatus }
  | { readonly kind: "budget"; readonly retryAfterSeconds: number }
  | { readonly kind: "frozen" };

export type AdminEvent =
  | { readonly action: "park"; readonly force: boolean; readonly reason: string }
  | { readonly action: "operator-hold"; readonly forSeconds: number; readonly reason: string }
  | { readonly action: "status"; readonly records: boolean };

export interface ControlApi {
  readonly status: (signal?: AbortSignal) => Promise<ControlStatus>;
  readonly wake: (opts: { readonly idempotencyKey: string; readonly origin: "user" | "auto" }) => Promise<WakeAnswer>;
  /** Poll status until `servingSince` (serving) or a running machine (running), or the signal fires. */
  readonly waitFor: (what: "running" | "serving", signal: AbortSignal) => Promise<ControlStatus>;
  readonly alertsTest: (severity: "page" | "notify") => Promise<void>;
  readonly admin: (event: AdminEvent) => Promise<unknown>;
}
