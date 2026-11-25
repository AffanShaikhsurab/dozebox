// adapters/files.ts on an in-memory filesystem (memfs, through the testkit's FakeFs).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeFakeFs } from "@dozebox/testkit/fakes";
import { makeNodeFiles, type FsPromises } from "../src/adapters/files.ts";

const setup = (files: Record<string, string> = {}) => {
  const fake = makeFakeFs(files);
  return { fake, fs: fake.fs.promises as unknown as FsPromises };
};

test("readText: the text, or null for a missing file", async () => {
  const { fs } = setup({ "/a/b.txt": "hello" });
  const files = makeNodeFiles(fs, 7);
  assert.equal(await files.readText("/a/b.txt"), "hello");
  assert.equal(await files.readText("/a/none.txt"), null);
});

test("readText: other errors are thrown", async () => {
  const { fs } = setup({ "/a/b.txt": "x" });
  await assert.rejects(makeNodeFiles(fs, 7).readText("/a/b.txt/c"), { code: "ENOTDIR" });
});

test("writeAtomic: creates the directory (0700), writes 0600, leaves no temporary file", async () => {
  const { fake, fs } = setup({ "/data/old.json": "old" });
  const files = makeNodeFiles(fs, 7);
  await files.writeAtomic("/data/dozebox/config/last-good.json", "new");
  await files.writeAtomic("/data/old.json", "replaced");
  assert.deepEqual(fake.snapshot(), { "/data/dozebox/config/last-good.json": "new", "/data/old.json": "replaced" });
  assert.equal(fake.vol.statSync("/data/dozebox/config/last-good.json").mode & 0o777, 0o600);
  assert.equal(fake.vol.statSync("/data/dozebox/config").mode & 0o777, 0o700);
});

test("writeAtomic: a failed rename keeps the old content and removes the temporary file", async () => {
  const { fake, fs } = setup({ "/data/x.json": "old" });
  const failing: FsPromises = {
    ...fs,
    rename: async () => Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" })),
  };
  await assert.rejects(makeNodeFiles(failing, 7).writeAtomic("/data/x.json", "new"), /EIO/);
  assert.deepEqual(fake.snapshot(), { "/data/x.json": "old" });
});
