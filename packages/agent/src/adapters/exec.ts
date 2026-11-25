// Child processes with node:child_process spawn: argv only (no shell), output collected as text, abortable.
import { spawn } from "node:child_process";
import type { Exec, ExecResult } from "../ports/exec.ts";

export function makeNodeExec(): Exec {
  return {
    run: (argv, opts = {}) =>
      new Promise<ExecResult>((resolve, reject) => {
        const [cmd, ...args] = argv;
        if (cmd === undefined) return reject(new Error("exec needs a command"));
        const child = spawn(cmd, args, {
          stdio: ["pipe", "pipe", "pipe"],
          ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
          ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
        child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code: code ?? -1, signal, stdout, stderr }));
        child.stdin.on("error", () => {});
        child.stdin.end(opts.input ?? "");
      }),
  };
}
