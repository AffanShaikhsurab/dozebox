// The log shipper's transport: redacted journald lines to the box's log stream. AWS: CloudWatch Logs.

export type LogEvent = { readonly at: number; readonly message: string };

export interface LogTransport {
  /**
   * Append `events` to `stream` in `group`, creating the stream when it is missing. Events are sent in time order
   * and split into batches the service accepts. Returns how many were accepted.
   */
  readonly send: (group: string, stream: string, events: ReadonlyArray<LogEvent>) => Promise<number>;
}
