// The box's record writes: stamp (`v`, `at`, writer tag), check and fit (core's encodeRecord), then put. Coalescing
// and backoff join here with the records package (A7); this is the minimal publisher the shell needs.
import { RunnerError } from "@dozebox/core/errors";
import { encodeRecord, type RecordName, type RecordTypes } from "@dozebox/core/records";
import { toInstant, type Clock } from "@dozebox/core/time";
import type { WriterTag } from "@dozebox/protocol/records";
import type { RecordWriter } from "../ports/records.ts";

type RecordBase = { readonly v: 1; readonly at: string; readonly writer: WriterTag };
/** A record without its base fields: the publisher adds them. */
type RecordBody<N extends RecordName> = Omit<RecordTypes[N], keyof RecordBase>;

export interface RecordPublisher {
  readonly put: <N extends RecordName>(name: N, body: RecordBody<N>) => Promise<void>;
  readonly delete: (name: RecordName) => Promise<void>;
  /** `rec/last-error`: `source` like `config` or `boot:attach`, `message` cut to the record's 1000 characters. */
  readonly lastError: (source: string, message: string) => Promise<void>;
}

const SOURCE = /^[a-z][a-z0-9:-]{0,40}$/;

export function makeRecordPublisher(deps: {
  readonly writer: RecordWriter;
  readonly clock: Pick<Clock, "now">;
  readonly tag: WriterTag;
}): RecordPublisher {
  const put = async <N extends RecordName>(name: N, body: RecordBody<N>): Promise<void> => {
    // The schema check in encodeRecord makes this cast safe: a body that does not complete the record is refused.
    const record = { ...body, v: 1, at: toInstant(deps.clock.now()), writer: deps.tag } as unknown as RecordTypes[N];
    const enc = encodeRecord(name, record);
    await deps.writer.put(name, enc.value, { tier: enc.tier });
  };
  return {
    put,
    delete: (name) => deps.writer.delete(name),
    lastError: (source, message) => {
      if (!SOURCE.test(source)) throw new RunnerError("invalid_input", false, `"${source}" is not an error source`);
      return put("rec/last-error", { source, message: message.slice(0, 1000) });
    },
  };
}
