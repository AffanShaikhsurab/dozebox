// Plugin point 2 (part 5 §5.6): one way to reach the operator. Built-ins: ntfy, email (SNS), webpush, webhook (C4).
import type { SecretReader } from "./sharedSecrets.ts";

export type AlertSeverity = "page" | "notify" | "info";

export type Alert = {
  /** Stable for one alert across retries. */
  readonly id: string;
  /** Dedupe key. */
  readonly key: string;
  readonly severity: AlertSeverity;
  /** Already sanitised, at most 120 characters. */
  readonly title: string;
  /** At most 1000 characters. */
  readonly body: string;
  readonly url?: string;
  /** `runner:<component>` or `payload:<name>`. */
  readonly source: string;
  /** Epoch ms. */
  readonly at: number;
};

export type DeliveryResult =
  | { readonly ok: true; readonly receiptExpected: boolean }
  | { readonly ok: false; readonly retryable: boolean; readonly reason: string };

export interface AlertSink {
  /** `ntfy`, `email`, `webpush`, `webhook`. */
  readonly id: string;
  /** Which severities this sink takes, from config. */
  readonly accepts: (severity: AlertSeverity) => boolean;
  /** Never throws: a failure is a DeliveryResult with `ok: false`. */
  readonly deliver: (alert: Alert, signal: AbortSignal) => Promise<DeliveryResult>;
}

/** C1's `Logger` (`src/log.ts`) satisfies this. Never pass a secret or a header value in `fields`. */
export interface SinkLogger {
  readonly log: (
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    fields?: Readonly<Record<string, string | number | boolean | null | undefined>>,
  ) => void;
}

export type SinkDeps = {
  readonly fetch: typeof fetch;
  readonly secrets: SecretReader;
  readonly log: SinkLogger;
};

export type AlertSinkMaker<C> = (config: C, deps: SinkDeps) => AlertSink;
