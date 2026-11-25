// Child processes (systemd-notify, systemctl, health commands). Argv arrays only: never a shell string.

export type ExecResult = {
  readonly code: number;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type ExecOptions = { readonly signal?: AbortSignal; readonly input?: string; readonly cwd?: string };

export interface Exec {
  /** Resolves with the exit status (non-zero is not an error); rejects when the program cannot start or is aborted. */
  readonly run: (argv: ReadonlyArray<string>, opts?: ExecOptions) => Promise<ExecResult>;
}
