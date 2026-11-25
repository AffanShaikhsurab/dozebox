import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { makeFakeClock, makeFakeExec, makeFakeFs } from "@dozebox/testkit/fakes";
import { makeNodeFiles, type FsPromises } from "../src/adapters/files.ts";
import { applyEgress, egressLoop, NFT_FILE, renderNftRules, resolveAllowHosts } from "../src/jail/egress.ts";
import type { JailConfig } from "../src/jail/types.ts";

const IMDS_ONLY: JailConfig = { enabled: true, egress: "imds-only", allowHosts: [] };
const ALLOW: JailConfig = { enabled: true, egress: "allowlist", allowHosts: ["api.github.com"] };
const lookupSome = async (h: string): Promise<string[]> => {
  if (h === "bad.example") throw new Error("ENOTFOUND");
  return ["10.0.0.2", "not-an-ip"];
};
const files = () => makeNodeFiles(makeFakeFs().fs.promises as unknown as FsPromises, 1);

describe("renderNftRules", () => {
  it("imds-only drops IMDS v4 and v6 for agent uids and allows the rest", () => {
    assert.equal(
      renderNftRules(IMDS_ONLY, [60_002, 60_001, 60_001], []),
      [
        "table inet dozebox_egress {}",
        "delete table inet dozebox_egress",
        "table inet dozebox_egress {",
        "  set agents {",
        "    type uid",
        "    elements = { 60001, 60002 }",
        "  }",
        "  chain output {",
        "    type filter hook output priority filter; policy accept;",
        "    meta skuid @agents ip daddr 169.254.169.254 drop",
        "    meta skuid @agents ip6 daddr fd00:ec2::254 drop",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("allowlist allows loopback, the VPC resolver and the resolved set, and rejects the rest", () => {
    const text = renderNftRules(ALLOW, [60_001], ["140.82.112.5", "2606:50c0::1", "140.82.112.5"]);
    assert.match(text, /set allow4 \{\n {4}type ipv4_addr\n {4}elements = \{ 140\.82\.112\.5 \}/);
    assert.match(text, /set allow6 \{\n {4}type ipv6_addr\n {4}elements = \{ 2606:50c0::1 \}/);
    const rules = text.split("\n").filter((l) => l.includes("meta skuid"));
    assert.deepEqual(rules, [
      "    meta skuid @agents ip daddr 169.254.169.254 drop",
      "    meta skuid @agents ip6 daddr fd00:ec2::254 drop",
      '    meta skuid @agents oifname "lo" accept',
      "    meta skuid @agents ip daddr 169.254.169.253 meta l4proto { tcp, udp } th dport 53 accept",
      "    meta skuid @agents ip daddr @allow4 accept",
      "    meta skuid @agents ip6 daddr @allow6 accept",
      "    meta skuid @agents reject with icmpx type admin-prohibited",
    ]);
    assert.ok(text.indexOf("169.254.169.254 drop") < text.indexOf("@allow4 accept"), "IMDS drop comes first");
  });

  it("an empty allow set has no elements line (nft refuses an empty one)", () => {
    assert.doesNotMatch(renderNftRules(ALLOW, [60_001], []), /elements = \{ {2}\}/);
  });

  it("jail off or no agent users leaves an empty table", () => {
    const empty = "table inet dozebox_egress {}\ndelete table inet dozebox_egress\ntable inet dozebox_egress {\n}\n";
    assert.equal(renderNftRules({ ...IMDS_ONLY, enabled: false }, [60_001], []), empty);
    assert.equal(renderNftRules(IMDS_ONLY, [], []), empty);
  });

  it("refuses a uid below 60000 and text that is not an IP", () => {
    assert.throws(() => renderNftRules(IMDS_ONLY, [0], []), TypeError);
    assert.throws(() => renderNftRules(ALLOW, [60_001], ["1.2.3.4; flush ruleset"]), TypeError);
  });
});

describe("applyEgress", () => {
  it("writes the file and loads it with nft -f", async () => {
    const f = files();
    const exec = makeFakeExec([{ match: ["nft"], outcome: { code: 0 } }]);
    await applyEgress({ exec, files: f }, "rules\n", new AbortController().signal);
    assert.equal(await f.readText(NFT_FILE), "rules\n");
    assert.deepEqual(exec.calls[0]?.argv, ["nft", "-f", NFT_FILE]);
  });

  it("fails closed: a failed load throws a non-retryable RunnerError", async () => {
    const exec = makeFakeExec([{ match: ["nft"], outcome: { code: 1, stderr: "Error: syntax error" } }]);
    await assert.rejects(
      applyEgress({ exec, files: files() }, "x", new AbortController().signal),
      (e: unknown) => e instanceof RunnerError && !e.retryable && /syntax error/.test(e.message),
    );
  });
});

describe("allow hosts and the egress loop", () => {
  it("keeps literal IPs, resolves names, drops failures", async () => {
    assert.deepEqual(await resolveAllowHosts(["1.1.1.1", "x.example", "bad.example"], lookupSome), [
      "1.1.1.1",
      "10.0.0.2",
    ]);
  });

  it("reloads only when the rules changed", async () => {
    const exec = makeFakeExec([{ match: ["nft"], outcome: { code: 0 } }]);
    let ips = ["10.0.0.1"];
    const loop = egressLoop({
      exec,
      files: files(),
      config: () => ALLOW,
      uids: () => [60_001],
      lookup: async () => ips,
    });
    assert.equal(loop.everyMs, 5 * 60_000);
    const signal = makeFakeClock().timeout(1000);
    await loop.tick(signal);
    await loop.tick(signal);
    assert.equal(exec.calls.length, 1);
    ips = ["10.0.0.9"];
    await loop.tick(signal);
    assert.equal(exec.calls.length, 2);
  });
});
