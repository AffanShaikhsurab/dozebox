export type ExecResult = {
  readonly code: number;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type ExecOptions = { readonly signal?: AbortSignal; readonly input?: string; readonly cwd?: string };

/** What a scripted command does: exit with a result, never exit until aborted, or fail to start. */
export type ExecOutcome = Partial<ExecResult> | { readonly hang: true } | { readonly throws: Error };

export type ExecScript = {
  /** Exact argv prefix, or a predicate over the full argv. */
  readonly match: ReadonlyArray<string> | ((argv: ReadonlyArray<string>) => boolean);
  readonly outcome: ExecOutcome | ((argv: ReadonlyArray<string>, opts: ExecOptions) => ExecOutcome);
  /** How many calls this script answers. Default: every matching call. */
  readonly times?: number;
};

export type ExecCall = { readonly argv: ReadonlyArray<string>; readonly opts: ExecOptions };

export type FakeExec = {
  readonly run: (argv: ReadonlyArray<string>, opts?: ExecOptions) => Promise<ExecResult>;
  readonly calls: ReadonlyArray<ExecCall>;
  /** Calls whose argv[0] is `cmd`. */
  readonly of: (cmd: string) => ReadonlyArray<ExecCall>;
};

/** Thrown for a command no script answers, so a test never runs something it did not expect. */
export class UnscriptedCommandError extends Error {
  readonly argv: ReadonlyArray<string>;
  constructor(argv: ReadonlyArray<string>) {
    super(`unscripted command: ${JSON.stringify(argv)}`);
    this.name = "UnscriptedCommandError";
    this.argv = argv;
  }
}

function matches(script: ExecScript, argv: ReadonlyArray<string>): boolean {
  if (typeof script.match === "function") return script.match(argv);
  return script.match.length <= argv.length && script.match.every((a, i) => argv[i] === a);
}

/** Scripted child processes: the first script whose match fits (and has calls left) decides the outcome. */
export function makeFakeExec(scripts: ReadonlyArray<ExecScript>): FakeExec {
  const calls: ExecCall[] = [];
  const used = new Map<ExecScript, number>();

  const run = (argv: ReadonlyArray<string>, opts: ExecOptions = {}): Promise<ExecResult> => {
    calls.push({ argv: [...argv], opts });
    const script = scripts.find((s) => matches(s, argv) && (s.times === undefined || (used.get(s) ?? 0) < s.times));
    if (!script) return Promise.reject(new UnscriptedCommandError(argv));
    used.set(script, (used.get(script) ?? 0) + 1);
    const outcome = typeof script.outcome === "function" ? script.outcome(argv, opts) : script.outcome;
    if ("throws" in outcome) return Promise.reject(outcome.throws);
    if ("hang" in outcome) {
      return new Promise<ExecResult>((_resolve, reject) => {
        if (opts.signal?.aborted) return reject(opts.signal.reason);
        opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
      });
    }
    return Promise.resolve({ code: 0, signal: null, stdout: "", stderr: "", ...outcome });
  };

  return { run, calls, of: (cmd) => calls.filter((c) => c.argv[0] === cmd) };
}
