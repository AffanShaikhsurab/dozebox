import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { establishedLocalPorts, sshPresenceSource, tcpPresenceSource } from "../src/protocol/sources.ts";

const HEAD = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const TCP = [
  HEAD,
  "   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1",
  "   1: 0A000005:0016 0A000009:D431 01 00000000:00000000 02:00000000 00000000     0        0 2 1",
  "   2: 0100007F:1F90 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 3 1",
  "",
].join("\n");
const TCP6 = [
  HEAD,
  "   0: 00000000000000000000000001000000:0BB8 00000000000000000000000001000000:A1B2 01 0:0 0:0 0 0 0 4 1",
].join("\n");
const T0 = 1_000_000;

const read = (files: Record<string, string>) => async (p: string) => {
  const t = files[p];
  if (t === undefined) throw new Error("ENOENT");
  return t;
};

describe("presence sources", () => {
  it("parses established local ports, skipping listeners", () => {
    assert.deepEqual([...establishedLocalPorts(TCP)], [22, 8080]);
    assert.deepEqual([...establishedLocalPorts(TCP6)], [3000]);
  });

  it("an established SSH connection is interactive src:ssh", async () => {
    const src = sshPresenceSource({ read: read({ "/proc/net/tcp": TCP }) });
    assert.deepEqual(await src.sample(T0, new AbortController().signal), [
      { id: "src:ssh", kind: "interactive", until: T0 + 90_000 },
    ]);
    const none = sshPresenceSource({ read: read({ "/proc/net/tcp": HEAD }) });
    assert.deepEqual(await none.sample(T0, new AbortController().signal), []);
  });

  it("connections to the payload's ports are viewing src:tcp:<port>, over tcp and tcp6", async () => {
    const src = tcpPresenceSource({
      read: read({ "/proc/net/tcp": TCP, "/proc/net/tcp6": TCP6 }),
      ports: () => [8080, 3000, 9999],
    });
    assert.deepEqual(
      (await src.sample(T0, new AbortController().signal)).map((s) => `${s.id}:${s.kind}`),
      ["src:tcp:8080:viewing", "src:tcp:3000:viewing"],
    );
  });
});
