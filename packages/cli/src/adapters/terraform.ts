// Terraform through `terraform -chdir=<dir> ...`. The spawn function is a dependency so tests use a fake child.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { DozeboxCliError } from "../command.ts";
import type { Terraform, TerraformOutputs } from "../ports/terraform.ts";

export type TerraformChild = Pick<ChildProcess, "stdout" | "stderr" | "kill" | "on">;
export type TerraformSpawn = (command: string, args: ReadonlyArray<string>) => TerraformChild;

export type TerraformDeps = {
  readonly spawn: TerraformSpawn;
  /** Where Terraform's own output goes (the CLI's stderr). */
  readonly stderr: (chunk: string) => void;
};

export const nodeTerraformSpawn: TerraformSpawn = (command, args) =>
  nodeSpawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });

const varArgs = (vars: Readonly<Record<string, string>>): string[] =>
  Object.entries(vars).flatMap(([k, v]) => ["-var", `${k}=${v}`]);

const failed = (command: string, code: number): DozeboxCliError =>
  new DozeboxCliError("problem", `terraform ${command} failed (exit ${code})`);

export function makeTerraform(deps: TerraformDeps): Terraform {
  function run(
    dir: string,
    args: ReadonlyArray<string>,
    opts: { readonly signal?: AbortSignal; readonly capture?: boolean },
  ): Promise<{ readonly code: number; readonly stdout: string }> {
    return new Promise((resolve, reject) => {
      const signal = opts.signal;
      if (signal?.aborted) return reject(signal.reason);
      const child = deps.spawn("terraform", [`-chdir=${dir}`, ...args]);
      let stdout = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (opts.capture === true) stdout += chunk;
        else deps.stderr(chunk);
      });
      child.stderr?.on("data", (chunk: string) => deps.stderr(chunk));
      const onAbort = (): void => void child.kill("SIGINT");
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (e: NodeJS.ErrnoException) => {
        signal?.removeEventListener("abort", onAbort);
        reject(
          e.code === "ENOENT"
            ? new DozeboxCliError("not-set-up", "terraform is not installed; see dozebox doctor", { cause: e })
            : new DozeboxCliError("problem", `terraform could not start: ${e.message}`, { cause: e }),
        );
      });
      child.on("close", (code: number | null) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) return reject(signal.reason);
        resolve({ code: code ?? 1, stdout });
      });
    });
  }

  async function succeed(
    command: string,
    dir: string,
    args: ReadonlyArray<string>,
    signal: AbortSignal,
  ): Promise<void> {
    const { code } = await run(dir, [command, ...args], { signal });
    if (code !== 0) throw failed(command, code);
  }

  return {
    init: (dir, signal) => succeed("init", dir, ["-input=false"], signal),
    apply: (dir, vars, signal) => succeed("apply", dir, ["-input=false", "-auto-approve", ...varArgs(vars)], signal),
    destroy: (dir, signal) => succeed("destroy", dir, ["-input=false", "-auto-approve"], signal),
    plan: async (dir, vars, signal) => {
      const { code } = await run(dir, ["plan", "-input=false", "-detailed-exitcode", ...varArgs(vars)], { signal });
      if (code === 0) return false;
      if (code === 2) return true;
      throw failed("plan", code);
    },
    output: async (dir) => {
      const { code, stdout } = await run(dir, ["output", "-json"], { capture: true });
      if (code !== 0) throw failed("output", code);
      return parseOutputs(stdout);
    },
  };
}

function parseOutputs(text: string): TerraformOutputs {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new DozeboxCliError("problem", "terraform output -json printed something that is not JSON", { cause });
  }
  const out: Record<string, { readonly value: unknown; readonly sensitive: boolean }> = {};
  if (typeof raw === "object" && raw !== null) {
    for (const [name, entry] of Object.entries(raw)) {
      const e = entry as { readonly value?: unknown; readonly sensitive?: unknown } | null;
      out[name] = { value: e?.value, sensitive: e?.sensitive === true };
    }
  }
  return out;
}
