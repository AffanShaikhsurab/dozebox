// The `--env-file` reader. The caller is untrusted, so root opens the realpathed path without following a symlink,
// checks the inode it got, reads from that fd, and unlinks the path only while it still names the same inode.
import { constants, type Stats } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { RunnerError } from "@dozebox/core/errors";
import { ENV_FILE_MAX_BYTES, envArgsContent, parseEnvFile } from "./exec.ts";

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const refuse = (why: string): RunnerError => new RunnerError("invalid_input", false, `jail exec: ${why}`);

/**
 * Read the `--env-file` as root, delete it, and return the bwrap `--args` stream. `ownerUid` is the caller's
 * (`SUDO_UID`): the file and its directory must be theirs (or root's), so a swap cannot reach another user's file.
 */
export async function takeEnvFile(path: string, ownerUid: number): Promise<string> {
  const parent = await lstat(dirname(path)).catch(() => null);
  if (parent === null || !parent.isDirectory()) throw refuse("the env file's directory is not a directory");
  if (parent.uid !== ownerUid && parent.uid !== 0)
    throw refuse("the env file's directory is not owned by the caller or root");
  const file = await open(path, OPEN_FLAGS).catch((e: unknown) => {
    const code = (e as { code?: unknown } | null)?.code;
    throw refuse(`the env file cannot be opened${typeof code === "string" ? ` (${code})` : ""}`);
  });
  // Set once the fd is the caller's own single-link regular file: only then may the path be unlinked below.
  let owned: Stats | null = null;
  try {
    const st = await file.stat();
    if (!st.isFile()) throw refuse("the env file is not a regular file");
    if (st.uid !== ownerUid) throw refuse("the env file is not owned by the caller");
    if (st.nlink !== 1) throw refuse("the env file has more than one link");
    owned = st;
    if (st.size > ENV_FILE_MAX_BYTES) throw refuse(`the env file is over ${ENV_FILE_MAX_BYTES} bytes`);
    const bytes = Buffer.alloc(ENV_FILE_MAX_BYTES + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > ENV_FILE_MAX_BYTES) throw refuse(`the env file is over ${ENV_FILE_MAX_BYTES} bytes`);
    }
    return envArgsContent(parseEnvFile(bytes.subarray(0, total)));
  } finally {
    await file.close();
    // Unlink only while the path still names the fd's inode, so a swap after the open leaves the new file alone.
    // Still racy inside the caller's own directory, which is the only place a caller can redirect it to.
    const now = owned === null ? null : await lstat(path).catch(() => null);
    if (owned !== null && now !== null && now.dev === owned.dev && now.ino === owned.ino)
      await unlink(path).catch(() => {});
  }
}
