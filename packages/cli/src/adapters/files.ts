// The operator's files. `writeText` is atomic (tmp then rename) and private (0o600): the stack cache sits next to
// operator state.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CliFiles } from "../ports/terraform.ts";

export function makeCliFiles(): CliFiles {
  return {
    readText: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    writeText: async (path, text) => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, path);
    },
  };
}
