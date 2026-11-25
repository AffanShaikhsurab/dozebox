// Logs and metrics (part 6 §6.8): one JSON object per line on stdout, which Lambda sends to CloudWatch Logs. Metrics are
// Embedded Metric Format lines in the stack's namespace without dimensions (the alarms of terraform/observability.tf
// read those series), so the function makes no PutMetricData calls. Never log a token, a header value or an SDK
// message (it can embed ARNs); log error names and codes.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export type Logger = {
  readonly log: (level: LogLevel, msg: string, fields?: LogFields) => void;
};

export type MetricName =
  | "ReconcileCompleted"
  | "ReconcileSkipped"
  | "WakeAccepted"
  | "WakeUnresolved"
  | "AlertDelivered"
  | "AlertFailed"
  | "RecordVersionUnknown"
  | "Bugs"
  | "AwakeSeconds"
  | "OnDemandSeconds";

export type Metrics = {
  /** Emit `value` (default 1) of `name`. `fields` go on the line as properties, not as dimensions. */
  readonly count: (name: MetricName, fields?: LogFields, value?: number) => void;
};

export type LogSink = (line: string) => void;

export type LogContext = {
  readonly box: string;
  readonly now: () => number;
  readonly sink?: LogSink;
  /** The Lambda request id of the current invocation, when known. */
  readonly requestId?: () => string | undefined;
};

const stdout: LogSink = (line) => process.stdout.write(`${line}\n`);

export function makeLogger(ctx: LogContext): Logger {
  const sink = ctx.sink ?? stdout;
  return {
    log: (level, msg, fields = {}) => {
      const requestId = ctx.requestId?.();
      sink(
        JSON.stringify({
          ts: new Date(ctx.now()).toISOString(),
          level,
          msg,
          component: "control",
          box: ctx.box,
          ...(requestId === undefined ? {} : { requestId }),
          ...fields,
        }),
      );
    },
  };
}

const UNITS: Readonly<Partial<Record<MetricName, string>>> = { AwakeSeconds: "Seconds", OnDemandSeconds: "Seconds" };

export function makeMetrics(ctx: LogContext & { readonly namespace: string }): Metrics {
  const sink = ctx.sink ?? stdout;
  return {
    count: (name, fields = {}, value = 1) => {
      sink(
        JSON.stringify({
          _aws: {
            Timestamp: ctx.now(),
            CloudWatchMetrics: [
              { Namespace: ctx.namespace, Dimensions: [[]], Metrics: [{ Name: name, Unit: UNITS[name] ?? "Count" }] },
            ],
          },
          [name]: value,
          box: ctx.box,
          ...fields,
        }),
      );
    },
  };
}
