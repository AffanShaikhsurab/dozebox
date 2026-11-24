import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeFakeFs } from "../src/fakes/fs.ts";

test("FakeFs starts from the seeded files and records writes in memory", async () => {
  const { fs, snapshot } = makeFakeFs({ "/data/dozebox/holds.json": "[]" });
  assert.equal(fs.readFileSync("/data/dozebox/holds.json", "utf8"), "[]");
  await fs.promises.mkdir("/run/dozebox", { recursive: true });
  await fs.promises.writeFile("/run/dozebox/status.json", '{"ok":true}');
  await fs.promises.rename("/run/dozebox/status.json", "/run/dozebox/status.json.bak");
  assert.deepEqual(snapshot(), {
    "/data/dozebox/holds.json": "[]",
    "/run/dozebox/status.json.bak": '{"ok":true}',
  });
});

test("FakeFs instances do not share state", () => {
  const a = makeFakeFs({ "/a": "1" });
  const b = makeFakeFs();
  assert.equal(b.fs.existsSync("/a"), false);
  assert.equal(a.fs.existsSync("/a"), true);
});
