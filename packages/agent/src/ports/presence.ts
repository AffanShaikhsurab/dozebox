// Plugin point 4 (part 5 §5.6): presence sources on the box. Built-ins: ssh, tcp (A2 runs them every 30 s).

export type PresenceSample = {
  /** Must start with `src:`. */
  readonly id: string;
  readonly kind: "interactive" | "viewing";
  readonly until: number;
};

export interface PresenceSource {
  /** `ssh`, `tcp`. */
  readonly id: string;
  /** Called every 30 s. Must finish in 2 s; a slow or throwing source is skipped for that tick. */
  readonly sample: (now: number, signal: AbortSignal) => Promise<ReadonlyArray<PresenceSample>>;
}
