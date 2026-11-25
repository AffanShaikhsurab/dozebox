// The router: public assets, unversioned aliases, 404/405/413, error mapping, alerts test, response headers.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { ControlErrorBody } from "@dozebox/protocol/control";
import Value from "typebox/value";
import { canonicalPath, route } from "../src/http/router.ts";
import { body, httpEvent, makeWorld } from "./fixture.ts";

describe("public assets", () => {
  test("the wake page is served without a token, with a CSP that pins its inline script and style", async () => {
    const w = makeWorld();
    const res = await w.call("GET", "/", { token: null });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
    const csp = res.headers["content-security-policy"] ?? "";
    for (const tag of ["script", "style"]) {
      const inline = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(res.body)?.[1] ?? "";
      const digest = createHash("sha256").update(inline).digest("base64");
      assert.ok(csp.includes(`'sha256-${digest}'`), `${tag} hash in the CSP`);
    }
    assert.ok(!csp.includes("unsafe-inline"));
    assert.ok(res.body.includes("x-dozebox-token"));
    assert.ok(!res.body.includes("?t="), "the token never travels in a query string");
    assert.deepEqual(w.computeCalls, []);
    assert.equal(w.tokenReads(), 0);
  });

  test("manifest, service worker and icon are public", async () => {
    const w = makeWorld();
    const types: Readonly<Record<string, string>> = {
      "/manifest.webmanifest": "application/manifest+json",
      "/sw.js": "text/javascript; charset=utf-8",
      "/icons/icon.svg": "image/svg+xml",
    };
    for (const [path, type] of Object.entries(types)) {
      const res = await w.call("GET", path, { token: null });
      assert.equal(res.statusCode, 200, path);
      assert.equal(res.headers["content-type"], type);
    }
    const manifest = body(await w.call("GET", "/manifest.webmanifest", { token: null }));
    assert.equal(manifest["display"], "standalone");
    assert.ok(!(await w.call("GET", "/sw.js", { token: null })).body.includes("caches.put"), "the API is never cached");
  });

  test("a POST to the page path needs the token like any route", async () => {
    const w = makeWorld();
    assert.equal((await w.call("POST", "/", { token: null })).statusCode, 401);
  });
});

describe("routing", () => {
  test("unversioned paths are aliases of /v1/", async () => {
    assert.deepEqual(
      ["/status", "/wake", "/park", "/alerts/test", "/v1/status", "/", "/other"].map(canonicalPath),
      ["/v1/status", "/v1/wake", "/v1/park", "/v1/alerts/test", "/v1/status", "/", "/other"],
    );
    const w = makeWorld();
    assert.equal((await w.call("GET", "/status")).statusCode, 200);
    assert.equal((await w.call("GET", "/status/")).statusCode, 200);
    assert.equal(body(await w.call("POST", "/wake")).decision, "accept");
    assert.equal(body(await w.call("POST", "/park")).decision, "accept");
  });

  test("405 with Allow for a known path and the wrong method; 404 for an unknown path", async () => {
    const w = makeWorld();
    const res = await w.call("POST", "/v1/status");
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers["allow"], "GET, OPTIONS");
    assert.equal((await w.call("GET", "/v1/wake")).statusCode, 405);
    const missing = await w.call("GET", "/v2/status");
    assert.equal(missing.statusCode, 404);
    assert.ok(Value.Check(ControlErrorBody, missing.json));
  });

  test("a body over 16 KiB is 413 before anything else is read", async () => {
    const w = makeWorld();
    const res = await w.call("POST", "/v1/alerts/test", { body: "x".repeat(16 * 1024 + 1) });
    assert.equal(res.statusCode, 413);
    assert.equal(w.tokenReads(), 0);
  });

  test("every answer carries no-store, nosniff and CORS", async () => {
    const w = makeWorld();
    for (const res of [await w.call("GET", "/v1/status"), await w.call("GET", "/v1/status", { token: null })]) {
      assert.equal(res.headers["cache-control"], "no-store");
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.headers["access-control-allow-origin"], "*");
    }
  });

  test("a thrown AWS error is 500 internal with no detail; a plain Error also counts as a bug", async () => {
    const w = makeWorld();
    w.aws.faults.failNext("ssm.get", "ThrottlingException");
    const res = await w.call("GET", "/v1/status");
    assert.equal(res.statusCode, 500);
    assert.deepEqual(body(res).error, {
      code: "internal",
      message: "The control function failed; try again.",
      retryable: true,
    });
    assert.ok(w.lines.some((l) => l.includes('"code":"aws_throttled"')));
    assert.ok(!w.lines.some((l) => l.includes('"Bugs"')));
    const broken = {
      ...w.deps,
      records: {
        ...w.deps.records,
        readAll: async () => {
          throw new Error("arn:aws:ssm:us-east-1:111122223333:parameter/x");
        },
      },
    };
    assert.equal((await route(broken, httpEvent("GET", "/v1/status"))).statusCode, 500);
    assert.ok(w.lines.some((l) => l.includes('"Bugs":1')));
    assert.ok(!w.lines.some((l) => l.includes("111122223333")), "error messages are not logged");
  });
});

describe("alerts test", () => {
  test("publishes one notice to the alert topic, then 429 for a minute", async () => {
    const w = makeWorld();
    const res = await w.call("POST", "/v1/alerts/test", { body: '{"severity":"page"}' });
    assert.equal(res.statusCode, 202);
    assert.equal(body(res).severity, "page");
    assert.equal(w.aws.sns.published.length, 1);
    assert.deepEqual(w.aws.sns.published[0]?.attributes, { severity: "page", kind: "test" });
    const again = await w.call("POST", "/v1/alerts/test");
    assert.equal(again.statusCode, 429);
    assert.equal(again.headers["retry-after"], "60");
    w.aws.clock.advance(61_000);
    assert.equal((await w.call("POST", "/v1/alerts/test")).statusCode, 202);
    assert.equal(body(await w.call("POST", "/v1/alerts/test", { body: "{" })).error !== undefined, true);
  });

  test("a body other than {severity} is 400", async () => {
    const w = makeWorld();
    for (const b of ["{", '{"severity":"info"}', '{"colour":"red"}', "[]"]) {
      assert.equal((await w.call("POST", "/v1/alerts/test", { body: b })).statusCode, 400, b);
    }
    assert.equal(w.aws.sns.published.length, 0);
  });
});
