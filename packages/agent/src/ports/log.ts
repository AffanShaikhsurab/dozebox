// Structured logs: one JSON object per line on stdout (journald on the box), part 6 §6.8.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  readonly log: (level: LogLevel, msg: string, fields?: LogFields) => void;
  /** A logger whose lines also carry `fields` (such as `component`). */
  readonly child: (fields: LogFields) => Logger;
}
