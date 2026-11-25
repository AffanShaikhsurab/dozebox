// Child processes the CLI starts itself (box mode `dozebox run -- <cmd...>`). Fake: testkit `makeFakeCliExec`.

export type ExecResult = { readonly exitCode: number; readonly signal: string | null };

export interface Exec {
  /** Runs `argv` with inherited stdio and env; `onOutput` fires for each line it prints (for beats). */
  readonly run: (
    argv: ReadonlyArray<string>,
    opts: { readonly onOutput: (line: string) => void; readonly signal: AbortSignal },
  ) => Promise<ExecResult>;
}
