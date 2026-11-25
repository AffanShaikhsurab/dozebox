// The box's data volumes, as the control function sees them. Exactly one volume of a box carries `active=true`.

export type VolumeState = "creating" | "available" | "in-use" | "deleting" | "deleted" | "error";
export type AttachmentState = "attaching" | "attached" | "detaching" | "detached" | "busy";

export type VolumeView = {
  readonly id: string;
  readonly state: VolumeState;
  readonly zone: string;
  readonly sizeGiB: number;
  /** The `<prefix>:active` tag is `true`. */
  readonly active: boolean;
  readonly attachments: ReadonlyArray<{ readonly machineId: string; readonly state: AttachmentState }>;
};

export interface Volumes {
  /** Every volume tagged `<prefix>:box=<boxId>`, oldest first. */
  readonly describeBox: (boxId: string) => Promise<ReadonlyArray<VolumeView>>;
  /**
   * Move `active=true` to `toId`, clearing it on `fromId` first (null when no volume holds it), so a crash between
   * the two leaves no active volume rather than two. Call only inside the lease.
   */
  readonly moveActive: (boxId: string, fromId: string | null, toId: string) => Promise<void>;
  /**
   * A new inactive volume of the box from `snapshotId` in `zone`. `token` makes a retry return the same volume
   * (AWS: CreateVolume ClientToken).
   */
  readonly createFromSnapshot: (opts: {
    readonly boxId: string;
    readonly snapshotId: string;
    readonly zone: string;
    readonly token: string;
  }) => Promise<string>;
}
