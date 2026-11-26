// adapters/imds.ts against the testkit's fake IMDSv2 (loopback).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { IMDS_TOKEN_HEADER, startFakeImds } from "@dozebox/testkit/fakes";
import { makeHttpImds } from "../src/adapters/imds.ts";

test("reads the identity document with a session token, reusing the token", async (t) => {
  const fake = await startFakeImds({ instanceId: "i-0aaaabbbbccccdddd", availabilityZone: "us-east-1b" });
  t.after(() => fake.close());
  const imds = makeHttpImds({ base: fake.base });
  const facts = await imds.instance();
  assert.deepEqual(facts, {
    instanceId: "i-0aaaabbbbccccdddd",
    region: "us-east-1",
    availabilityZone: "us-east-1b",
    instanceType: "t4g.small",
    lifecycle: "spot",
  });
  await imds.instance();
  assert.deepEqual(
    fake.requests.map((r) => `${r.method} ${r.path}`),
    [
      "PUT /latest/api/token",
      "GET /latest/dynamic/instance-identity/document",
      "GET /latest/meta-data/instance-life-cycle",
      "GET /latest/dynamic/instance-identity/document",
      "GET /latest/meta-data/instance-life-cycle",
    ],
  );
  assert.ok(fake.requests.slice(1).every((r) => r.token === fake.requests[1]?.token && r.token !== null));
});

test("an On-Demand instance reads as on-demand", async (t) => {
  const fake = await startFakeImds({ lifecycle: "on-demand" });
  t.after(() => fake.close());
  assert.equal((await makeHttpImds({ base: fake.base }).instance()).lifecycle, "on-demand");
  fake.setLifecycle("spot");
  assert.equal((await makeHttpImds({ base: fake.base }).instance()).lifecycle, "spot");
});

test("an expired token is replaced once", async (t) => {
  const fake = await startFakeImds();
  t.after(() => fake.close());
  const imds = makeHttpImds({ base: `${fake.base}/` });
  await imds.instance();
  fake.expireTokens();
  assert.equal((await imds.instance()).instanceId, fake.identity.instanceId);
  assert.equal(fake.requests.filter((r) => r.path === "/latest/api/token").length, 2);
});

test("server errors are retryable aws_unavailable; others are internal", async (t) => {
  const fake = await startFakeImds();
  t.after(() => fake.close());
  const imds = makeHttpImds({ base: fake.base });
  fake.failNext(503);
  await assert.rejects(imds.instance(), (e) => e instanceof RunnerError && e.code === "aws_unavailable" && e.retryable);
  fake.failNext(404);
  await assert.rejects(imds.instance(), (e) => e instanceof RunnerError && e.code === "internal" && !e.retryable);
});

const fetchStub: typeof fetch = async (url) =>
  new Response(String(url).endsWith("/token") ? "tok" : JSON.stringify({ instanceId: "i-0123456789abcdef0" }));

test("a document without a field is refused", async () => {
  await assert.rejects(makeHttpImds({ fetch: fetchStub }).instance(), /IMDS document has no region/);
  assert.equal(IMDS_TOKEN_HEADER, "x-aws-ec2-metadata-token");
});

const tagged: typeof fetch = async (url) => new Response(String(url).endsWith("/token") ? "tok" : "dozebox-box-1-spot");

test("tag: the instance tag's value, null when IMDS has none (404)", async (t) => {
  const fake = await startFakeImds();
  t.after(() => fake.close());
  assert.equal(await makeHttpImds({ base: fake.base }).tag("aws:autoscaling:groupName"), null);
  assert.equal(fake.requests.at(-1)?.path, "/latest/meta-data/tags/instance/aws:autoscaling:groupName");
  assert.equal(await makeHttpImds({ fetch: tagged }).tag("aws:autoscaling:groupName"), "dozebox-box-1-spot");
  assert.throws(() => makeHttpImds({ fetch: tagged }).tag("bad key/../x"), /bad tag key/);
});
