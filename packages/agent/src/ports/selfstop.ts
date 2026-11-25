// How the box puts itself to sleep. AWS: StopInstances on itself, or the group's desired capacity to 0.

export type SelfStopTarget =
  | { readonly mode: "persistent"; readonly instanceId: string }
  | { readonly mode: "group"; readonly instanceId: string; readonly groupName: string };

export interface SelfStop {
  /** Stopping a machine that is already stopping or stopped is not an error. */
  readonly stopSelf: (target: SelfStopTarget) => Promise<void>;
}
