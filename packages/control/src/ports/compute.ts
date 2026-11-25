// The control function's view of machines, in cloud-neutral words (part 6 §6.2). AWS: EC2 and Auto Scaling.

export type MachineState = "pending" | "running" | "stopping" | "stopped" | "shutting-down" | "terminated";

export type MachineView = {
  readonly id: string;
  readonly state: MachineState;
  readonly lifecycle: "spot" | "on-demand";
  /** Epoch ms of the last launch or start. */
  readonly launchedAt: number;
  /** Epoch ms the last stop began (one-second resolution on AWS), or null when not known. */
  readonly stoppingAt: number | null;
  /** The persistent Spot request behind a Spot machine; `none` for On-Demand. */
  readonly spotRequest: "active" | "disabled" | "marked-for-stop" | "none";
  /** Instance type and availability zone, for the status view; absent when the cloud did not say. */
  readonly type?: string;
  readonly zone?: string;
};

export type GroupView = { readonly desired: 0 | 1; readonly machines: ReadonlyArray<MachineView> };

/**
 * `token` is derived from the intent id, never the clock. AWS's StartInstances, StopInstances and SetDesiredCapacity
 * take no client token, so there it is only recorded; the reconciler's re-read before acting carries idempotency.
 */
export interface Compute {
  /** The box's persistent machine, found by the `<prefix>:box` and `<prefix>:role=persistent` tags, or null. */
  readonly describePersistent: (boxId: string) => Promise<MachineView | null>;
  readonly startPersistent: (id: string, token: string) => Promise<void>;
  readonly stopPersistent: (id: string, token: string) => Promise<void>;
  /** Throws RunnerError `aws_not_found` when the group does not exist. */
  readonly describeGroup: (name: string) => Promise<GroupView>;
  readonly setGroupDesired: (name: string, desired: 0 | 1, token: string) => Promise<void>;
}
