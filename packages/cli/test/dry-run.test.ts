import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXIT } from "../src/command.ts";
import { COMMANDS } from "../src/commands/index.ts";
import { fakeDeps, mutatingCalls, run } from "./harness.ts";
import { makeFakePrompt, stackOutputsFixture, type FakeCliDeps } from "@dozebox/testkit/fakes";

/** A box with an active volume, a snapshot, a secret and a token, so every mutating command has work to do. */
function busyDeps(): FakeCliDeps {
  const deps = { ...fakeDeps(), prompt: makeFakePrompt(true, ["secret-value"]) };
  deps.terraform.changes = true;
  deps.terraform.outputs = stackOutputsFixture({ unfreeze_runbook: { document: "d", parameters: {} } });
  deps.aws.volumeList.push(
    { id: "vol-a", zone: "us-east-1a", state: "available", active: true, retired: false },
    { id: "vol-b", zone: "us-east-1a", state: "available", active: false, retired: true },
  );
  deps.aws.snapshotList.push({ id: "snap-1", volumeId: "vol-a", state: "completed", startedAt: 0, label: "x" });
  deps.aws.secretValues.set("ntfy-url", "https://ntfy.example/x");
  deps.aws.params.set("/dozebox/main/wake-token", { value: "t".repeat(43), secure: true });
  deps.aws.params.set("/dozebox/main/phones/a1a1a1a1a1a1", {
    value: '{"hash":"h","label":"x","at":"2026-11-25T00:00:00.000Z"}',
    secure: false,
  });
  return deps;
}

/** argv per mutating operator command (one row per command name). */
const ROWS: Readonly<Record<string, ReadonlyArray<string>>> = {
  deploy: ["deploy"],
  wake: ["wake", "--wait"],
  park: ["park", "--force"],
  upgrade: ["upgrade", "--agent", "1.2.3"],
  doctor: ["doctor", "--fix"],
  bootstrap: ["bootstrap", "--region", "us-east-1"],
  setup: ["setup"],
  "secrets set": ["secrets", "set", "ntfy-url"],
  "secrets delete": ["secrets", "delete", "ntfy-url"],
  "token rotate": ["token", "rotate"],
  "phone pair": ["phone", "pair"],
  "phone revoke": ["phone", "revoke", "a1a1a1a1a1a1"],
  "alerts test": ["alerts", "test"],
  "snapshots create": ["snapshots", "create"],
  "snapshots delete": ["snapshots", "delete", "snap-1"],
  restore: ["restore", "latest"],
  "volumes retire": ["volumes", "retire", "vol-b"],
  "move-az": ["move-az", "us-east-1b"],
  rebuild: ["rebuild"],
  unfreeze: ["unfreeze", "--reason", "drill"],
  destroy: ["destroy"],
};

describe("--dry-run makes no mutating call", () => {
  for (const [name, argv] of Object.entries(ROWS)) {
    it(name, async () => {
      const deps = busyDeps();
      const r = await run(deps, [...argv, "--dry-run"]);
      assert.ok(r.code === EXIT.ok || r.code === EXIT.problem, `exit ${r.code}: ${r.err.join(" ")}`);
      assert.deepEqual(mutatingCalls(deps), []);
    });
  }

  it("every mutating operator command has a row", () => {
    const names = COMMANDS.filter((c) => c.mode !== "box" && c.mutates && c.name !== "drill").map((c) => c.name);
    assert.deepEqual(
      names.filter((n) => ROWS[n] === undefined),
      [],
    );
  });

  it("prints the calls it skipped", async () => {
    const r = await run(busyDeps(), ["park", "--dry-run"]);
    assert.match(r.out.join("\n"), /dry-run: lambda invoke admin \{"action":"park"/);
  });
});
