// What the handler, the routes and the tick get: config, clock, log, metrics, the ports, and the stores over them.
// `makeDeps(env)` wires the AWS adapters; tests build the same shape over FakeAws with `assembleDeps`.
import { makeAwsPorts, type AwsPorts } from "./adapters/aws/ports.ts";
import { parseControlConfig, type ControlConfig } from "./config.ts";
import { makeTokenCheck, tokenHeaders, type TokenCheck } from "./http/auth.ts";
import type { FunctionUrlResult } from "./http/event.ts";
import { makeLogger, makeMetrics, type Logger, type LogSink, type Metrics } from "./log.ts";
import { makeDesiredStore, makeWakeLedger, type DesiredStore, type WakeLedgerStore } from "./state/desired.ts";

/**
 * Answers stored by `Idempotency-Key` (part 6 §6.3: a repeat returns the same 202 and does nothing). C2 replaces the
 * default, which remembers nothing, with entries in the state table kept 24 h.
 */
export type WakeIdempotency = {
  readonly recall: (key: string) => Promise<FunctionUrlResult | null>;
  readonly remember: (key: string, answer: FunctionUrlResult) => Promise<void>;
};

export const NO_IDEMPOTENCY: WakeIdempotency = { recall: async () => null, remember: async () => {} };

export type Deps = AwsPorts & {
  readonly config: ControlConfig;
  readonly clock: { readonly now: () => number };
  readonly log: Logger;
  readonly metrics: Metrics;
  readonly auth: TokenCheck;
  readonly tokenHeaders: ReadonlyArray<string>;
  readonly desired: DesiredStore;
  readonly wakeLedger: WakeLedgerStore;
  readonly idempotency: WakeIdempotency;
  /** The id this container holds the reconcile lease with. */
  readonly invocationId: string;
  /** The current Lambda request id, set by the handler for log lines. */
  readonly setRequestId: (id: string | undefined) => void;
};

export type AssembleOptions = {
  readonly config: ControlConfig;
  readonly ports: AwsPorts;
  readonly now: () => number;
  readonly sink?: LogSink;
  readonly invocationId?: string;
  readonly idempotency?: WakeIdempotency;
};

export function assembleDeps(o: AssembleOptions): Deps {
  let requestId: string | undefined;
  const ctx = {
    box: o.config.box.id,
    now: o.now,
    requestId: () => requestId,
    ...(o.sink === undefined ? {} : { sink: o.sink }),
  };
  const headers = tokenHeaders(o.config.http?.tokenHeaders ?? []);
  return {
    ...o.ports,
    config: o.config,
    clock: { now: o.now },
    log: makeLogger(ctx),
    metrics: makeMetrics({ ...ctx, namespace: o.config.metrics.namespace }),
    auth: makeTokenCheck({ source: o.ports.wakeToken, now: o.now, headers }),
    tokenHeaders: headers,
    desired: makeDesiredStore(o.ports.state),
    wakeLedger: makeWakeLedger(o.ports.state),
    idempotency: o.idempotency ?? NO_IDEMPOTENCY,
    invocationId: o.invocationId ?? crypto.randomUUID(),
    setRequestId: (id) => {
      requestId = id;
    },
  };
}

export function makeDeps(env: Readonly<Record<string, string | undefined>>): Deps {
  const config = parseControlConfig(env["DOZEBOX_CONTROL"]);
  const now = () => Date.now();
  return assembleDeps({ config, ports: makeAwsPorts(config, now), now });
}
