// The wake token the control API compares against (part 5 §5.3). AWS: the SSM SecureString `/<prefix>/<box>/wake-token`.

export interface WakeTokenSource {
  /** The stored token without surrounding white space, or null when none is stored yet. */
  readonly read: () => Promise<string | null>;
}
