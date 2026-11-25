// A8: the jail settings the agent acts on (from the box config `jail` and `tripwire` sections).

export type EgressMode = "imds-only" | "allowlist";

export type JailConfig = {
  readonly enabled: boolean;
  readonly egress: EgressMode;
  readonly allowHosts: ReadonlyArray<string>;
};
