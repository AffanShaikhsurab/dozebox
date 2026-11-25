// Reads of the box's own parameters under `/<prefix>/<boxId>/`: `config` and `payloads/<name>` (Terraform writes
// them; the box role may read them, and `ctl/*`, but never write them).

export interface ParameterReader {
  /** The parameter's value, or null when it does not exist. `name` is relative to the box root. */
  readonly get: (name: string) => Promise<string | null>;
}
