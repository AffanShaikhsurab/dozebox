import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeFakeFs } from "@dozebox/testkit/fakes";
import { makeNodeFiles, type FsPromises } from "../src/adapters/files.ts";
import { DECOY_CONFIG } from "../src/jail/bwrap.ts";
import {
  hitLine,
  makeTripwire,
  renderDecoyConfig,
  TRIPWIRE_HITS,
  tripwireAlert,
  tripwireKey,
} from "../src/jail/tripwire.ts";

const T0 = Date.parse("2026-11-25T00:00:00.000Z");

function setup() {
  const files = makeNodeFiles(makeFakeFs().fs.promises as unknown as FsPromises, 1);
  const modes: string[] = [];
  const tw = makeTripwire({ files, now: () => T0, chmod: async (p, m) => void modes.push(`${p}:${m.toString(8)}`) });
  const append = async (received: string) =>
    files.writeAtomic(TRIPWIRE_HITS, `${(await files.readText(TRIPWIRE_HITS)) ?? ""}${hitLine(received, T0)}`);
  return { files, tw, modes, append };
}

describe("tripwire", () => {
  it("arm writes a decoy profile readable by agents whose credential_process is the helper", async () => {
    const { files, tw, modes } = setup();
    await tw.arm();
    assert.equal(await files.readText(DECOY_CONFIG), renderDecoyConfig("us-east-1"));
    assert.match(
      renderDecoyConfig("us-east-1"),
      /^credential_process = \/opt\/dozebox\/current\/bin\/dozebox-tripwire$/m,
    );
    assert.deepEqual(modes, [`${DECOY_CONFIG}:644`]);
  });

  it("a decoy-key report is a hit with the jail exec context, paged as tripwire:<context>", async () => {
    const { tw, append } = setup();
    await tw.arm();
    await append("decoy-key thread-42\n");
    const hits = await tw.hits();
    assert.deepEqual(hits, [{ at: T0, what: "decoy-key", detail: "context=thread-42" }]);
    const alert = tripwireAlert(hits[0]!);
    assert.equal(alert.key, "tripwire:thread-42");
    assert.equal(alert.severity, "page");
    assert.match(alert.body, /decoy AWS profile was used.*context=thread-42/);
  });

  it("anything else on the socket is a decoy-socket hit, with the untrusted text cleaned", async () => {
    const { tw, append } = setup();
    await append("GET / HTTP/1.1\r\n$(rm -rf /)\n");
    const [hit] = await tw.hits();
    assert.equal(hit?.what, "decoy-socket");
    assert.doesNotMatch(hit?.detail ?? "", /[$()\r]/);
    assert.equal(tripwireKey(hit!), "tripwire:socket");
  });

  it("hits() returns only new hits; hits before arm are not paged again", async () => {
    const { tw, append } = setup();
    await append("decoy-key old\n");
    await tw.arm();
    assert.deepEqual(await tw.hits(), []);
    await append("decoy-key a\n");
    await append("decoy-key b\n");
    assert.deepEqual(
      (await tw.hits()).map((h) => h.detail),
      ["context=a", "context=b"],
    );
    assert.deepEqual(await tw.hits(), []);
  });

  it("a malformed line in the file is skipped", async () => {
    const { files, tw } = setup();
    await files.writeAtomic(TRIPWIRE_HITS, `not json\n${hitLine("decoy-key c", T0)}`);
    assert.deepEqual(
      (await tw.hits()).map((h) => h.detail),
      ["context=c"],
    );
  });
});
