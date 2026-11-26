// agent-view.ts: the status reports the instance facts the identity resolved from IMDS, never a fixed lifecycle.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildStatus, type AgentView } from "../src/agent-view.ts";
import type { ProtocolStore } from "../src/protocol/index.ts";
import { IDENTITY } from "./support.ts";

const store = { listHolds: () => [], listWakes: () => [] } as unknown as ProtocolStore;

const view = (lifecycle: "spot" | "on-demand"): AgentView => ({
  identity: { ...IDENTITY, lifecycle },
  bootedAt: 1_000,
  phase: { phase: "serving", since: 1_000 },
  verdict: null,
  disk: null,
  jail: { ready: true, egress: "off", missing: [] },
  memoryBytes: 2 ** 31,
  cpus: 2,
  awakeSecondsCap: null,
});

test("the status reports the instance lifecycle from IMDS", () => {
  for (const lifecycle of ["spot", "on-demand"] as const) {
    const status = buildStatus(view(lifecycle), store, null, 2_000);
    assert.equal(status.box.instance.lifecycle, lifecycle);
    assert.equal(status.box.instance.id, IDENTITY.instanceId);
  }
});
