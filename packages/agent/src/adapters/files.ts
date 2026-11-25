// State files on the local disk through node:fs/promises (or any module with the same shape, such as memfs in tests).
import { dirname } from "node:path";
import type { Files } from "../ports/files.ts";

/** The subset of `node:fs/promises` this adapter uses. */
export type FsPromises = {
  readonly readFile: (path: string, encoding: "utf8") => Promise<string | Buffer>;
  readonly writeFile: (path: string, data: string, opts: { readonly mode: number }) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly mkdir: (path: string, opts: { readonly recursive: true; readonly mode: number }) => Promise<unknown>;
  readonly rm: (path: string, opts: { readonly force: true }) => Promise<void>;
};

const isMissing = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === "ENOENT";

export function makeNodeFiles(fs: FsPromises, pid: number = process.pid): Files {
  let seq = 0;
  return {
    readText: async (path) => {
      try {
        return String(await fs.readFile(path, "utf8"));
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
    },
    writeAtomic: async (path, text) => {
      await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp-${pid}-${seq++}`;
      try {
        await fs.writeFile(tmp, text, { mode: 0o600 });
        await fs.rename(tmp, path);
      } catch (e) {
        await fs.rm(tmp, { force: true });
        throw e;
      }
    },
  };
}
