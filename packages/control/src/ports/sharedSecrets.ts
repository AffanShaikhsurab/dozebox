// SecureString reads under `/<prefix>/shared/` (sink URLs, hook secrets, VAPID keys). AWS: SSM GetParameter with
// decryption. The control function never logs a value it read here.

export interface SecretReader {
  /** The decrypted value, or null when the parameter does not exist. `name` is relative to `/<prefix>/shared/`. */
  readonly get: (name: string) => Promise<string | null>;
}
