// The bundle Terraform deploys: dist/control.zip holds one control.mjs that exports `handler`, the same bytes on
// every build, and it answers a Function URL request on its own (a missing DOZEBOX_CONTROL is a 500, not a crash).
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { buildBundle } from "../scripts/build.ts";
import { unzip } from "../scripts/zip.ts";
import { httpEvent } from "./fixture.ts";

test("control.zip holds control.mjs, is deterministic, and the bundle handles a request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dz-control-"));
  try {
    const first = readFileSync((await buildBundle(join(dir, "a"))).zipPath);
    const second = readFileSync((await buildBundle(join(dir, "b"))).zipPath);
    assert.ok(first.equals(second), "same source, same zip bytes");
    const entries = unzip(first);
    assert.deepEqual([...entries.keys()], ["control.mjs"]);
    const file = join(dir, "control.mjs");
    writeFileSync(file, entries.get("control.mjs") ?? Buffer.alloc(0));
    const mod: unknown = await import(pathToFileURL(file).href);
    const handler = (mod as { readonly handler?: unknown }).handler;
    assert.equal(typeof handler, "function");
    const saved = process.env["DOZEBOX_CONTROL"];
    delete process.env["DOZEBOX_CONTROL"];
    try {
      const res = await (handler as (e: unknown) => Promise<{ readonly statusCode: number }>)(
        httpEvent("GET", "/v1/status"),
      );
      assert.equal(res.statusCode, 500);
    } finally {
      if (saved !== undefined) process.env["DOZEBOX_CONTROL"] = saved;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
