import { RunnerError } from "@dozebox/core/errors";
import type { PayloadDefinition } from "@dozebox/protocol/payload";
import type { Files } from "../ports/files.ts";

export type SecretDeps = {
  readonly files: Files;
  readonly secret: (name: string) => Promise<string | null>;
};

/** Fetch the definition's SecureStrings into `/run/dozebox/credentials/<payload>/<name>` (0600, root). */
export async function writeCredentials(deps: SecretDeps, def: PayloadDefinition): Promise<ReadonlyArray<string>> {
  const dir = `/run/dozebox/credentials/${def.name}`;
  const fileNames: string[] = [];
  const envLines: string[] = [];
  for (const s of def.secrets ?? []) {
    const value = await deps.secret(s.name);
    if (value === null) {
      if (s.optional) continue;
      throw new RunnerError("invalid_input", false, `payload ${def.name}: secret "${s.name}" is missing`);
    }
    if ("file" in s.as) {
      await deps.files.writeAtomic(`${dir}/${s.as.file}`, value);
      fileNames.push(s.as.file);
    } else {
      if (/[\r\n]/.test(value)) {
        throw new RunnerError("invalid_input", false, `payload ${def.name}: secret "${s.name}" has a newline`);
      }
      envLines.push(`${s.as.env}=${value}`);
    }
  }
  if (envLines.length > 0) await deps.files.writeAtomic(`${dir}/env`, `${envLines.join("\n")}\n`);
  return fileNames;
}
