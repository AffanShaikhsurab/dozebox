// Attention and runner alerts from the box to the operator's topic. AWS: SNS. Undelivered ones go into rec/liveness.

export type BoxNotice = {
  readonly subject: string;
  readonly body: string;
  readonly attributes?: Readonly<Record<string, string>>;
};

export interface BoxNotifier {
  /** Returns the message id. */
  readonly publish: (notice: BoxNotice) => Promise<string>;
}
