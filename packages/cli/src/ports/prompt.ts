// Questions to the person at the terminal. `--yes` answers every confirm; `--json` without `--yes` refuses.

export interface Prompt {
  readonly confirm: (question: string) => Promise<boolean>;
  /** Read a secret value from stdin (no echo), never from argv. */
  readonly secret: (label: string) => Promise<string>;
}
