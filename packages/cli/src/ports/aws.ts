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
  /** EC2 volume state: `creating`, `available`, `in-use`, ... */
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

export type EmailSubscription = { readonly endpoint: string; readonly pending: boolean };

export interface AwsOps {
  /** Every snapshot tagged to the box, newest first. */
  readonly snapshots: (boxId: string) => Promise<ReadonlyArray<SnapshotView>>;
  /** `token` makes a retry return the same snapshot. Tags it to the box (from the volume's tags). */
  readonly createSnapshot: (volumeId: string, label: string, token: string) => Promise<string>;
  readonly deleteSnapshot: (id: string) => Promise<void>;
  /** Every volume tagged to the box (active, retired or neither). */
  readonly volumes: (boxId: string) => Promise<ReadonlyArray<CliVolumeView>>;
  /** A new encrypted volume from a snapshot in `zone`, tagged to the box but not active. `token` as above. */
  readonly createVolume: (input: {
    readonly snapshotId: string;
    readonly zone: string;
    readonly boxId: string;
    readonly token: string;
  }) => Promise<string>;
  readonly retireVolume: (id: string) => Promise<void>;
  /** SecureString under `/<prefix>/shared/<name>`; the value never comes from argv. */
  readonly putSecret: (name: string, value: string) => Promise<void>;
  readonly listSecrets: () => Promise<ReadonlyArray<string>>;
  readonly deleteSecret: (name: string) => Promise<void>;
  /** SSM parameter by full name, decrypted; null when it does not exist. */
  readonly getParameter: (name: string) => Promise<string | null>;
  /** Overwrites. `secure` writes a SecureString. */
  readonly putParameter: (name: string, value: string, opts: { readonly secure: boolean }) => Promise<void>;
  /** Full names of the parameters directly under `path` (ends with `/`). */
  readonly listParameters: (path: string) => Promise<ReadonlyArray<string>>;
  readonly deleteParameter: (name: string) => Promise<void>;
  readonly doctorFacts: () => Promise<DoctorFacts>;
  /** Activates a user-defined cost allocation tag (Cost Explorer); a no-op when it is active. */
  readonly activateCostTag: (key: string) => Promise<void>;
  /** The caller's ARN (STS GetCallerIdentity). */
  readonly callerArn: () => Promise<string>;
  /** Starts an SSM Automation execution; returns its id. AccessDenied maps to RunnerError `aws_denied`. */
  readonly startAutomation: (document: string, params: Readonly<Record<string, string>>) => Promise<string>;
  readonly emailSubscriptions: (topicArn: string) => Promise<ReadonlyArray<EmailSubscription>>;
  readonly subscribeEmail: (topicArn: string, email: string) => Promise<void>;
  /** Month-to-date spend on `dozebox:test` (drills refuse above 60% of the test budget). */
  readonly testSpendUsd: () => Promise<number | null>;
}
