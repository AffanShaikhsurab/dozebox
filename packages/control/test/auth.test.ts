// Token auth: the table of part 13 WP-C1 (missing, wrong, right, alias), the hashed constant-time comparison, and
// the cache rules (a stored token cached 60 s, "none stored" never cached).
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { ControlErrorBody } from "@dozebox/protocol/control";
import Value from "typebox/value";
import { TOKEN_CACHE_MS, tokenHeaders, tokenMatches } from "../src/http/auth.ts";
import { body, makeWorld, TOKEN } from "./fixture.ts";

const ALIAS = "x-legacy-token";

describe("auth table", () => {
  const rows: ReadonlyArray<{
    readonly name: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly aliases?: ReadonlyArray<string>;
    readonly status: number;
  }> = [
    { name: "missing", headers: {}, status: 401 },
    { name: "empty", headers: { "x-dozebox-token": "  " }, status: 401 },
    { name: "wrong", headers: { "x-dozebox-token": "wrong" }, status: 401 },
    { name: "right token, other case", headers: { "x-dozebox-token": TOKEN.toUpperCase() }, status: 401 },
    { name: "a prefix of the right token", headers: { "x-dozebox-token": TOKEN.slice(0, -1) }, status: 401 },
    { name: "right", headers: { "x-dozebox-token": TOKEN }, status: 200 },
    { name: "right, header name in another case", headers: { "X-Dozebox-Token": TOKEN }, status: 200 },
    { name: "right, surrounding white space", headers: { "x-dozebox-token": ` ${TOKEN} ` }, status: 200 },
    { name: "Authorization is not a token header", headers: { authorization: `Bearer ${TOKEN}` }, status: 401 },
    { name: "alias when the stack lists it", headers: { [ALIAS]: TOKEN }, aliases: [ALIAS], status: 200 },
    { name: "alias when the stack does not list it", headers: { [ALIAS]: TOKEN }, status: 401 },
    { name: "wrong alias", headers: { [ALIAS]: "wrong" }, aliases: [ALIAS], status: 401 },
    {
      name: "the primary header wins over an alias",
      headers: { "x-dozebox-token": "wrong", [ALIAS]: TOKEN },
      aliases: [ALIAS],
      status: 401,
    },
  ];
  for (const r of rows) {
    test(`${r.name} -> ${r.status}`, async () => {
      const w = makeWorld({ config: { http: { tokenHeaders: [...(r.aliases ?? [])] } } });
      const res = await w.call("GET", "/v1/status", { token: null, headers: r.headers });
      assert.equal(res.statusCode, r.status);
      if (r.status === 401) {
        assert.ok(Value.Check(ControlErrorBody, res.json));
        assert.equal((body(res).error as { code: string }).code, "unauthorized");
        assert.deepEqual(w.computeCalls, [], "nothing is read before the token is checked");
      }
    });
  }

  test("an unknown path without the token is 401, not 404: no route is revealed", async () => {
    const w = makeWorld();
    assert.equal((await w.call("GET", "/v1/nothing", { token: "wrong" })).statusCode, 401);
    assert.equal((await w.call("GET", "/v1/nothing")).statusCode, 404);
  });

  test("the log line names the outcome, never the token", async () => {
    const w = makeWorld();
    await w.call("GET", "/v1/status", { token: "wrong-secret-value" });
    assert.ok(w.lines.some((l) => l.includes('"outcome":"wrong"')));
    assert.ok(!w.lines.some((l) => l.includes("wrong-secret-value") || l.includes(TOKEN)));
  });

  test("CORS allows the token headers the stack accepts", async () => {
    const w = makeWorld({ config: { http: { tokenHeaders: [ALIAS] } } });
    const res = await w.call("OPTIONS", "/v1/wake", { token: null });
    assert.equal(res.statusCode, 204);
    assert.equal(
      res.headers["access-control-allow-headers"],
      `content-type, idempotency-key, x-dozebox-token, ${ALIAS}`,
    );
  });
});

describe("tokenMatches", () => {
  test("compares sha256 digests, so any lengths compare without throwing", () => {
    assert.equal(tokenMatches("a", "a"), true);
    assert.equal(tokenMatches("a", "a".repeat(1000)), false);
    assert.equal(tokenMatches("é", "é"), true);
    assert.equal(tokenMatches("", ""), false);
    assert.equal(tokenMatches("x", ""), false);
  });

  test("the primary header is always first and aliases are lower case, without duplicates", () => {
    assert.deepEqual(tokenHeaders(["X-Legacy-Token", "x-dozebox-token"]), ["x-dozebox-token", "x-legacy-token"]);
  });
});

describe("token cache", () => {
  test("a stored token is read once per 60 s; a rotated token works after the cache expires", async () => {
    const w = makeWorld();
    await w.call("GET", "/v1/status");
    await w.call("GET", "/v1/status");
    assert.equal(w.tokenReads(), 1);
    w.setToken("rotated-token");
    w.aws.clock.advance(TOKEN_CACHE_MS - 1);
    assert.equal((await w.call("GET", "/v1/status")).statusCode, 200);
    w.aws.clock.advance(1);
    assert.equal((await w.call("GET", "/v1/status")).statusCode, 401);
    assert.equal((await w.call("GET", "/v1/status", { token: "rotated-token" })).statusCode, 200);
    assert.equal(w.tokenReads(), 2);
  });

  test("no stored token is never cached: the first call after setup writes it succeeds", async () => {
    const w = makeWorld();
    w.setToken(null);
    assert.equal((await w.call("GET", "/v1/status")).statusCode, 401);
    w.setToken(TOKEN);
    assert.equal((await w.call("GET", "/v1/status")).statusCode, 200);
    assert.equal(w.tokenReads(), 2);
  });

  test("a call without a token does not read the stored one", async () => {
    const w = makeWorld();
    await w.call("GET", "/v1/status", { token: null });
    assert.equal(w.tokenReads(), 0);
  });
});
