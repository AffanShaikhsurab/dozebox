// The agent's own state files (`/data/dozebox/...`): the last good config and, later, holds and wakes.

export interface Files {
  /** The file's text, or null when it does not exist. */
  readonly readText: (path: string) => Promise<string | null>;
  /**
   * Replace `path` with `text` atomically: write a sibling temporary file (mode 0600), then rename it over `path`, so
   * a crash leaves either the old or the new content, never half of one. Creates the parent directory.
   */
  readonly writeAtomic: (path: string, text: string) => Promise<void>;
}
