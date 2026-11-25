// The AWS calls the CLI makes itself (not through the control function): snapshots, volumes, secrets, doctor facts,
// drills. Each AWS call lives in `adapters/aws/` (dependency-cruiser); fake: testkit `makeFakeAwsOps`.

export type SnapshotView = {
  readonly id: string;
  readonly volumeId: string;
  readonly state: "pending" | "completed" | "error";
  readonly startedAt: number;
  readonly label: string | null;
};

export type CliVolumeView = {
  readonly id: string;
  readonly zone: string;
  readonly state: string;
  readonly active: boolean;
  readonly retired: boolean;
};

export type DoctorFacts = {
  readonly account: string | null;
  readonly region: string | null;
  readonly costTagActive: boolean | null;
  readonly unreservedConcurrency: number | null;
  readonly spotVcpuQuota: number | null;
  readonly onDemandVcpuQuota: number | null;
};

export interface AwsOps {
  readonly snapshots: (boxId: string) => Promise<ReadonlyArray<SnapshotView>>;
  /** `token` makes a retry return the same snapshot. */
  readonly createSnapshot: (volumeId: string, label: string, token: string) => Promise<string>;
  readonly deleteSnapshot: (id: string) => Promise<void>;
  readonly volumes: (boxId: string) => Promise<ReadonlyArray<CliVolumeView>>;
  readonly retireVolume: (id: string) => Promise<void>;
  /** SecureString under `/<prefix>/shared/<name>`; the value never comes from argv. */
  readonly putSecret: (name: string, value: string) => Promise<void>;
  readonly listSecrets: () => Promise<ReadonlyArray<string>>;
  readonly deleteSecret: (name: string) => Promise<void>;
  readonly doctorFacts: () => Promise<DoctorFacts>;
  /** Month-to-date spend on `dozebox:test` (drills refuse above 60% of the test budget). */
  readonly testSpendUsd: () => Promise<number | null>;
}
