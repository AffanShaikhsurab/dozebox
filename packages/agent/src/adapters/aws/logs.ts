// AWS adapter for the log shipper's transport: CloudWatch Logs PutLogEvents into the box's log group (created by
// Terraform; the box role may only create streams in it and put events). PutLogEvents rules this follows:
// - events in time order within a batch; at most 10,000 events and 1,048,576 bytes per batch, where each event
//   counts its UTF-8 message bytes plus 26; one batch spans at most 24 hours;
// - an event message is 1 to 262,144 bytes here (the long-standing per-event limit): a longer one is cut at a
//   character boundary with a marker, an empty one is sent as one space;
// - sequence tokens are no longer used, so none is sent.
// A missing stream (ResourceNotFoundException) is created once (an "already exists" race is fine) and the batch is
// sent again; a missing group is aws_not_found. Events the service refuses as too old, too new or past retention
// are counted out of the result through `rejectedLogEventsInfo`. A failed batch throws; the batches before it of
// the same call were stored, so a full retry can repeat them (CloudWatch Logs does not deduplicate).
import {
  CreateLogStreamCommand,
  PutLogEventsCommand,
  type CloudWatchLogsClient,
  type InputLogEvent,
  type RejectedLogEventsInfo,
} from "@aws-sdk/client-cloudwatch-logs";
import { fromAws } from "@dozebox/core/errors";
import type { LogEvent, LogTransport } from "../../ports/logs.ts";

export type AwsLogTransportDeps = { readonly logs: CloudWatchLogsClient };

const MAX_BATCH_EVENTS = 10_000;
const MAX_BATCH_BYTES = 1_048_576;
const EVENT_OVERHEAD = 26;
const MAX_EVENT_BYTES = 262_144 - EVENT_OVERHEAD;
const MAX_SPAN_MS = 24 * 60 * 60 * 1000;
const CUT = " [truncated]";

const utf8 = new TextEncoder();
const size = (s: string): number => utf8.encode(s).length;

function fit(message: string): string {
  if (message === "") return " ";
  if (size(message) <= MAX_EVENT_BYTES) return message;
  const room = MAX_EVENT_BYTES - size(CUT);
  let used = 0;
  let end = 0;
  for (const ch of message) {
    const n = size(ch);
    if (used + n > room) break;
    used += n;
    end += ch.length;
  }
  return `${message.slice(0, end)}${CUT}`;
}

/** Split time-ordered events into batches PutLogEvents accepts. */
function batches(events: ReadonlyArray<LogEvent>): InputLogEvent[][] {
  const out: InputLogEvent[][] = [];
  let current: InputLogEvent[] = [];
  let bytes = 0;
  for (const e of [...events].toSorted((a, b) => a.at - b.at)) {
    const message = fit(e.message);
    const cost = size(message) + EVENT_OVERHEAD;
    const first = current[0]?.timestamp;
    const full =
      current.length === MAX_BATCH_EVENTS ||
      bytes + cost > MAX_BATCH_BYTES ||
      (first !== undefined && e.at - first >= MAX_SPAN_MS);
    if (full && current.length > 0) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push({ timestamp: e.at, message });
    bytes += cost;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** How many of `count` events the service kept, from its rejection report. */
export function acceptedCount(count: number, info: RejectedLogEventsInfo | undefined): number {
  if (!info) return count;
  const firstKept = Math.max(info.tooOldLogEventEndIndex ?? -1, info.expiredLogEventEndIndex ?? -1) + 1;
  const end = Math.min(info.tooNewLogEventStartIndex ?? count, count);
  return Math.max(0, end - firstKept);
}

export function makeAwsLogTransport(deps: AwsLogTransportDeps): LogTransport {
  const { logs } = deps;
  const createStream = async (group: string, stream: string): Promise<void> => {
    try {
      await logs.send(new CreateLogStreamCommand({ logGroupName: group, logStreamName: stream }));
    } catch (e) {
      if ((e as { readonly name?: unknown }).name === "ResourceAlreadyExistsException") return;
      throw fromAws(e);
    }
  };
  const put = (group: string, stream: string, logEvents: InputLogEvent[]) =>
    logs.send(new PutLogEventsCommand({ logGroupName: group, logStreamName: stream, logEvents }));

  return {
    send: async (group, stream, events) => {
      let accepted = 0;
      for (const batch of batches(events)) {
        let out;
        try {
          out = await put(group, stream, batch);
        } catch (e) {
          const err = fromAws(e);
          if (err.code !== "aws_not_found") throw err;
          await createStream(group, stream);
          try {
            out = await put(group, stream, batch);
          } catch (again) {
            throw fromAws(again);
          }
        }
        accepted += acceptedCount(batch.length, out.rejectedLogEventsInfo);
      }
      return accepted;
    },
  };
}
