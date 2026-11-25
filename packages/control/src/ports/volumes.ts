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

/** A completed snapshot of the box's data volume (DLM copies the volume's tags onto it). */
export type SnapshotView = {
  readonly id: string;
  /** Epoch ms the snapshot was started. */
  readonly startedAt: number;
  readonly sizeGiB: number;
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
  /**
   * Detach `volumeId` from `machineId` (the fallback hand-off: the stopped persistent instance releases the volume to
   * the group's instance). A volume not attached to `machineId` (already detached or detaching) succeeds; a missing
   * volume is `aws_not_found`. `token` is the intent token (DetachVolume takes no client token; logged only).
   * Call only inside the lease, after re-reading that the machine is stopped.
   */
  readonly detach: (volumeId: string, machineId: string, token: string) => Promise<void>;
  /** The newest `completed` snapshot tagged `<prefix>:box=<boxId>` that this account owns, or null. */
  readonly newestSnapshot: (boxId: string) => Promise<SnapshotView | null>;
  /**
   * Delete an inactive, unattached volume of a box (the restore test's scratch volume). A missing or already deleted
   * volume succeeds. Refuses a volume tagged `active=true` or without the `<prefix>:box` tag (`invalid_input`), and
   * an attached one (`aws_conflict`). `token` as in `detach`.
   */
  readonly deleteVolume: (volumeId: string, token: string) => Promise<void>;
}
