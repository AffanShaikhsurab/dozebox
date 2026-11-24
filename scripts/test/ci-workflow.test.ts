// The Wave J lesson: a path-filtered required job that never ran was recorded as green. A docs-only PR must run
// every required job, and `ci-ok` must fail when any job failed, was cancelled or was skipped.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

type Workflow = {
  on: Record<string, unknown>;
  jobs: Record<string, { needs?: string[]; if?: string; steps: Array<{ run?: string }> }>;
};

const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as Workflow;

test("ci.yml has no path filters, so a docs-only PR runs every job", () => {
  for (const [event, config] of Object.entries(ci.on)) {
    const keys = config && typeof config === "object" ? Object.keys(config) : [];
    assert.ok(!keys.includes("paths") && !keys.includes("paths-ignore"), `${event} has a path filter`);
  }
  for (const [name, job] of Object.entries(ci.jobs)) {
    if (name === "ci-ok") continue;
    assert.equal(job.if, undefined, `job ${name} is conditional`);
  }
});

test("ci-ok needs every other job and rejects failure, cancelled and skipped", () => {
  const okJob = ci.jobs["ci-ok"];
  assert.ok(okJob, "ci-ok exists");
  const others = Object.keys(ci.jobs).filter((n) => n !== "ci-ok");
  assert.deepEqual((okJob.needs ?? []).toSorted(), others.toSorted());
  assert.equal(okJob.if, "always()");
  const script = okJob.steps.map((s) => s.run ?? "").join("\n");
  for (const result of ["failure", "cancelled", "skipped"]) assert.match(script, new RegExp(result));
});

test("ci.yml runs on pull requests, pushes to main and the merge queue", () => {
  assert.deepEqual(Object.keys(ci.on).toSorted(), ["merge_group", "pull_request", "push"]);
});
