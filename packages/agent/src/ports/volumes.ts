// The box attaches its own data volume at boot. Never force-detach.

export type AttachedVolume = {
  readonly id: string;
  readonly zone: string;
  readonly active: boolean;
  /** The machine it is attached to and the attachment state, or null when it is free. */
  readonly attachment: {
    readonly machineId: string;
    readonly state: "attaching" | "attached" | "detaching" | "busy";
  } | null;
};

export interface VolumeAttach {
  /** The one volume tagged `<prefix>:box=<boxId>` and `<prefix>:active=true`, or null. */
  readonly findActive: (boxId: string) => Promise<AttachedVolume | null>;
  readonly describe: (volumeId: string) => Promise<AttachedVolume | null>;
  /**
   * Attach `volumeId` to `machineId` as `device`. Refused with RunnerError `aws_denied` when the volume is not the
   * box's active volume: the same tag fence IAM enforces, checked here too because emulators do not evaluate it.
   */
  readonly attach: (opts: {
    readonly boxId: string;
    readonly volumeId: string;
    readonly machineId: string;
    readonly device: string;
  }) => Promise<void>;
}
