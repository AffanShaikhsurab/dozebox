import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeFakeCliDeps, makeFakeCliFiles, stackOutputsFixture, controlStatusFixture } from "@dozebox/testkit/fakes";
import { makePriceLookup, parsePriceList } from "../src/drills/price.ts";

const product = (usd: string): string =>
  JSON.stringify({
    product: { attributes: { instanceType: "t4g.small" } },
    terms: {
      OnDemand: { "X.JRTCKXETXF": { priceDimensions: { "X.JRTCKXETXF.6YS6EN2CT7": { pricePerUnit: { USD: usd } } } } },
    },
  });

function setup(answer: (args: ReadonlyArray<string>) => unknown) {
  const deps = makeFakeCliDeps({ status: controlStatusFixture(), outputs: stackOutputsFixture() });
  deps.awsCli.answer = answer;
  const fs = makeFakeCliFiles();
  const lookup = makePriceLookup({ awsCli: deps.awsCli, fs, clock: deps.clock, cacheFile: "price.json" });
  return { deps, fs, lookup };
}

describe("parsePriceList", () => {
  it("reads the USD price from the JSON strings", () => {
    assert.equal(parsePriceList({ PriceList: [product("0.0168000000")] }), 0.0168);
    assert.equal(parsePriceList({ PriceList: [] }), null);
    assert.equal(parsePriceList({ PriceList: ["not json"] }), null);
    assert.equal(parsePriceList(null), null);
  });
});

describe("makePriceLookup", () => {
  it("asks the Price List API with the Linux shared-tenancy filters", async () => {
    const { deps, lookup } = setup(() => ({ PriceList: [product("0.0168")] }));
    assert.equal(await lookup("us-east-1", "t4g.small"), 0.0168);
    const args = deps.awsCli.calls[0] ?? [];
    assert.deepEqual(args.slice(0, 6), [
      "pricing",
      "get-products",
      "--region",
      "us-east-1",
      "--service-code",
      "AmazonEC2",
    ]);
    for (const f of [
      "instanceType,Value=t4g.small",
      "regionCode,Value=us-east-1",
      "operatingSystem,Value=Linux",
      "tenancy,Value=Shared",
      "preInstalledSw,Value=NA",
      "capacitystatus,Value=Used",
    ]) {
      assert.ok(
        args.some((a) => a.includes(f)),
        f,
      );
    }
  });

  it("caches per UTC day", async () => {
    const { deps, lookup, fs } = setup(() => ({ PriceList: [product("0.0168")] }));
    await lookup("us-east-1", "t4g.small");
    await lookup("us-east-1", "t4g.small");
    assert.equal(deps.awsCli.calls.length, 1);
    assert.equal(JSON.parse(fs.files.get("price.json") ?? "{}").day, "2026-11-25");
    await deps.clock.sleep(24 * 3600 * 1000);
    await lookup("us-east-1", "t4g.small");
    assert.equal(deps.awsCli.calls.length, 2);
  });

  it("falls back on a table price and flags it when the call fails or has no price", async () => {
    const failing = setup(() => {
      throw new Error("denied");
    });
    assert.equal(await failing.lookup("us-east-1", "t4g.medium"), 0.0336);
    assert.deepEqual(failing.lookup.fallbacks, ["us-east-1/t4g.medium"]);
    const empty = setup(() => ({ PriceList: [] }));
    assert.equal(await empty.lookup("us-east-1", "t4g.large"), 0.0672);
    assert.equal(empty.lookup.fallbacks.length, 1);
    assert.equal(empty.fs.files.has("price.json"), false);
  });
});
