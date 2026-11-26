// jail/envFile.ts against a real filesystem. The caller is untrusted: a symlink, or a swap after the realpath check,
// must not make root read or delete a file the caller does not own.
import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { takeEnvFile } from "../src/jail/envFile.ts";

const POSIX = process.platform !== "win32";
const uid = process.getuid?.() ?? 0;
const SKIP = POSIX ? false : "POSIX ownership, links and symlinks";

let root = "";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "dz-env-file-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const put = async (name: string, content: string): Promise<string> => {
  const path = join(root, name);
  await writeFile(path, content, { mode: 0o600 });
  return path;
};

const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe("jail env file on a real filesystem", { skip: SKIP }, () => {
  it("reads a good file from the fd and deletes it", async () => {
    const path = await put("good.env", "HOME=/data/x\0TOKEN=s3cret\0");
    assert.equal(await takeEnvFile(path, uid), "--setenv\0HOME\0/data/x\0--setenv\0TOKEN\0s3cret\0");
    assert.equal(await exists(path), false, "the env file is still there");
  });

  it("refuses a symlinked env file and never deletes its target", async () => {
    const target = await put("target.env", "TOKEN=s3cret\0");
    const linkPath = join(root, "link.env");
    await symlink(target, linkPath);
    await assert.rejects(takeEnvFile(linkPath, uid), /cannot be opened/);
    assert.equal(await exists(target), true, "the symlink target was deleted");
    assert.equal(await exists(linkPath), true, "the symlink was deleted");
  });

  it("refuses a file swapped to a symlink after the realpath check", async () => {
    const path = await put("swap.env", "TOKEN=s3cret\0");
    const real = await realpath(path);
    const target = await put("swap-target.env", "OTHER=x\0");
    await rm(path);
    await symlink(target, real);
    await assert.rejects(takeEnvFile(real, uid), /cannot be opened/);
    assert.equal(await exists(target), true, "the symlink target was deleted");
  });

  it("refuses a file owned by someone other than the caller", async () => {
    // Directly in tmpdir(), which root owns, so the directory check passes and the file's owner is what refuses.
    const path = join(tmpdir(), `dz-env-file-owner-${process.pid}.env`);
    await writeFile(path, "TOKEN=s3cret\0", { mode: 0o600 });
    try {
      await assert.rejects(takeEnvFile(path, uid + 1), /not owned by the caller/);
      assert.equal(await exists(path), true, "a refused file was deleted");
    } finally {
      await rm(path, { force: true });
    }
  });

  it("refuses a directory owned by neither the caller nor root", async () => {
    if (uid === 0) return; // root is always allowed, so there is nothing to refuse here
    const path = await put("dir-owner.env", "TOKEN=s3cret\0");
    await assert.rejects(takeEnvFile(path, uid + 1), /directory is not owned by the caller or root/);
    assert.equal(await exists(path), true, "a refused file was deleted");
  });

  it("refuses a file with more than one link", async () => {
    const path = await put("linked.env", "TOKEN=s3cret\0");
    const second = join(root, "linked-2.env");
    await link(path, second);
    await assert.rejects(takeEnvFile(path, uid), /more than one link/);
    assert.equal(await exists(path), true, "a refused file was deleted");
    assert.equal(await exists(second), true, "the other link was deleted");
  });

  it("refuses a directory, a missing file and a file over 1 MiB", async () => {
    const dir = join(root, "dir.env");
    await mkdir(dir);
    await assert.rejects(takeEnvFile(dir, uid), /not a regular file/);
    await assert.rejects(takeEnvFile(join(root, "missing.env"), uid), /cannot be opened \(ENOENT\)/);
    const big = await put("big.env", "A=".padEnd(1024 * 1024 + 2, "x"));
    await assert.rejects(takeEnvFile(big, uid), /over 1048576 bytes/);
    assert.equal(await exists(big), false, "the caller's own refused file is still deleted");
  });

  it("refuses a symlinked parent directory", async () => {
    const real = join(root, "realdir");
    await mkdir(real);
    await writeFile(join(real, "e.env"), "TOKEN=s3cret\0", { mode: 0o600 });
    const parentLink = join(root, "dirlink");
    await symlink(real, parentLink);
    await assert.rejects(takeEnvFile(join(parentLink, "e.env"), uid), /directory is not a directory/);
    assert.equal(await exists(join(real, "e.env")), true, "the file behind the parent link was deleted");
  });
});
