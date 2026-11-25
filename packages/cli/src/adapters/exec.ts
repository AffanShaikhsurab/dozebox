// Child processes for box mode `dozebox run -- <cmd...>`: inherited stdin, output passed through and reported by line.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import { DozeboxCliError } from "../command.ts";
import type { Exec } from "../ports/exec.ts";

type ExecChild = Pick<ChildProcess, "stdout" | "stderr" | "kill" | "on">;

export type ExecDeps = {
  readonly spawn: (command: string, args: ReadonlyArray<string>) => ExecChild;
  readonly stdout: (chunk: string) => void;
  readonly stderr: (chunk: string) => void;
};

export const nodeExecSpawn: ExecDeps["spawn"] = (command, args) =>
  nodeSpawn(command, [...args], { stdio: ["inherit", "pipe", "pipe"] });

export function makeExec(deps: ExecDeps): Exec {
  return {
    run: (argv, opts) =>
      new Promise((resolve, reject) => {
        const [command, ...args] = argv;
        if (command === undefined) return reject(new DozeboxCliError("usage", "nothing to run after --"));
        if (opts.signal.aborted) return reject(opts.signal.reason);
        const child = deps.spawn(command, args);
        const pipe = (stream: ExecChild["stdout"], write: (chunk: string) => void): (() => void) => {
          let rest = "";
          stream?.setEncoding("utf8");
          stream?.on("data", (chunk: string) => {
            write(chunk);
            const lines = (rest + chunk).split(/\r?\n/);
            rest = lines.pop() ?? "";
            for (const line of lines) opts.onOutput(line);
          });
          return () => {
            if (rest !== "") opts.onOutput(rest);
            rest = "";
          };
        };
        const flushOut = pipe(child.stdout, deps.stdout);
        const flushErr = pipe(child.stderr, deps.stderr);
        const onAbort = (): void => void child.kill("SIGTERM");
        opts.signal.addEventListener("abort", onAbort, { once: true });
        child.on("error", (e: NodeJS.ErrnoException) => {
          opts.signal.removeEventListener("abort", onAbort);
          if (e.code === "ENOENT") {
            deps.stderr(`${command}: command not found\n`);
            return resolve({ exitCode: 127, signal: null });
          }
          reject(new DozeboxCliError("problem", `could not start ${command}: ${e.message}`, { cause: e }));
        });
        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
          opts.signal.removeEventListener("abort", onAbort);
          flushOut();
          flushErr();
          const exitCode = code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0));
          resolve({ exitCode, signal });
        });
      }),
  };
}
