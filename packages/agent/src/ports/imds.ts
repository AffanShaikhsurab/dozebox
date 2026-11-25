// The instance metadata service (IMDSv2: every read needs a session token). The agent reads its own facts here, never
// from DescribeInstances (the box role has no DescribeInstances).

export type InstanceFacts = {
  readonly instanceId: string;
  readonly region: string;
  readonly availabilityZone: string;
  readonly instanceType: string;
};

export interface Imds {
  readonly instance: (signal?: AbortSignal) => Promise<InstanceFacts>;
  /** One instance tag (instance metadata tags are on in the launch template), or null when it is not set. */
  readonly tag: (key: string, signal?: AbortSignal) => Promise<string | null>;
}
