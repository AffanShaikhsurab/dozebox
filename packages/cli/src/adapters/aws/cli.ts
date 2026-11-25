// AwsCli over the `aws` binary (AWS CLI v2).
import { execFile } from "node:child_process";
import { DozeboxCliError } from "../../command.ts";
import type { AwsCli } from "../../ports/awscli.ts";

export type AwsCliSpawn = (
  args: ReadonlyArray<string>,
  signal: AbortSignal | undefined,
) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;

export const nodeAwsSpawn: AwsCliSpawn = (args, signal) =>
  new Promise((resolve) => {
    execFile(
      "aws",
      [...args],
      { encoding: "utf8", maxBuffer: 64 * 2 ** 20, ...(signal === undefined ? {} : { signal }) },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout, stderr: stderr || (error?.message ?? "") });
      },
    );
  });

export function makeAwsCli(deps: { readonly spawn: AwsCliSpawn }): AwsCli {
  return {
    json: async (args, signal) => {
      const r = await deps.spawn([...args, "--output", "json"], signal);
      if (signal?.aborted) throw signal.reason;
      if (r.code !== 0) {
        const op = args.slice(0, 2).join(" ");
        throw new DozeboxCliError("aws", `aws ${op}: ${r.stderr.trim().slice(-600)}`);
      }
      const text = r.stdout.trim();
      if (text === "") return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    },
  };
}
