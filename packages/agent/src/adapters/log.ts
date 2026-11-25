// JSON lines on stdout (part 6 §6.8): `ts`, `level`, `msg`, then the fixed fields (`component`, `box`,
// `instanceId`, `bootId`) and the line's own fields. Errors become `{ name, message, code }` (no stack for
// RunnerError, the stack for plain Errors, which are bugs).
import { RunnerError } from "@dozebox/core/errors";
import type { LogFields, Logger } from "../ports/log.ts";

function plain(value: unknown): unknown {
  if (value instanceof RunnerError) return { name: value.name, code: value.code, message: value.message };
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

export function makeJsonLogger(write: (line: string) => void, now: () => number, base: LogFields = {}): Logger {
  return {
    log: (level, msg, fields = {}) => {
      const extra = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, plain(v)]));
      write(`${JSON.stringify({ ts: new Date(now()).toISOString(), level, msg, ...base, ...extra })}\n`);
    },
    child: (fields) => makeJsonLogger(write, now, { ...base, ...fields }),
  };
}
