// One message to the operator's alert topic. AWS: SNS. Sinks (ntfy, web push, webhook) are separate (phase 5).

export type Notice = {
  /** Shown as the e-mail subject: trimmed to what the topic accepts, never refused for its characters. */
  readonly subject: string;
  readonly body: string;
  /** Message attributes for subscription filters, such as `severity`. */
  readonly attributes?: Readonly<Record<string, string>>;
};

export interface Notifier {
  /** Returns the message id. */
  readonly publish: (notice: Notice) => Promise<string>;
}
