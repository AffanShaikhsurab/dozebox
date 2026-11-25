// Versions of the operator's local tools, for `doctor`.
import { execFile } from "node:child_process";
import type { ToolName, Tools } from "../ports/tools.ts";

export type ToolsDeps = {
  /** Stdout of `command args`, or null when the command is not installed or fails. */
  readonly run: (command: string, args: ReadonlyArray<string>) => Promise<string | null>;
  readonly nodeVersion: string;
};

export const runCapture: ToolsDeps["run"] = (command, args) =>
  new Promise((resolve) => {
    execFile(command, [...args], { encoding: "utf8", timeout: 15_000 }, (error, stdout) => {
      resolve(error === null ? stdout : null);
    });
  });

function terraformVersion(text: string): string | null {
  try {
    const v = (JSON.parse(text) as { readonly terraform_version?: unknown }).terraform_version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export function makeTools(deps: ToolsDeps): Tools {
  return {
    version: async (tool: ToolName) => {
      if (tool === "node") return deps.nodeVersion;
      if (tool === "terraform") {
        const out = await deps.run("terraform", ["version", "-json"]);
        return out === null ? null : terraformVersion(out);
      }
      const out = await deps.run("aws", ["--version"]);
      if (out === null) return null;
      return /aws-cli\/(\S+)/.exec(out)?.[1] ?? (out.trim() || null);
    },
  };
}
