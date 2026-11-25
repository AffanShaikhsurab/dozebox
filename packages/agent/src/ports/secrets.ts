// Shared SecureStrings under `/<prefix>/shared/<name>` (part 8 �8.3), read for payload credentials (A3).

export interface SecretReader {
  /** The decrypted value, or null when the parameter does not exist. */
  readonly get: (name: string) => Promise<string | null>;
}
