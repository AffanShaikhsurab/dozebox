import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

// Static checks over the SSM Automation runbooks (terraform/runbooks/*.yaml): the shape SSM accepts for schema 0.3,
// every {{ reference }} declared, and the one-way rule of the kill switch (kill never detaches, unfreeze never
// attaches). The emulator, when it supports SSM documents, validates them for real.
type Step = { name: string; action: string; inputs: Record<string, unknown>; onFailure?: string };
type Runbook = {
  schemaVersion: string;
  assumeRole: string;
  description: string;
  parameters: Record<string, { type: string; default?: unknown }>;
  mainSteps: Step[];
};

const ACTIONS = new Set(["aws:executeAwsApi", "aws:executeScript"]);
const PARAMETER_TYPES = new Set(["String", "StringList", "Boolean", "Integer", "MapList", "StringMap"]);

function load(name: string): Runbook {
  const doc: unknown = parse(readFileSync(join(process.cwd(), "terraform", "runbooks", name), "utf8"));
  assert.ok(typeof doc === "object" && doc !== null, `${name} is not a YAML mapping`);
  return doc as Runbook;
}

function references(value: unknown): string[] {
  if (typeof value === "string") return [...value.matchAll(/\{\{\s*([A-Za-z0-9_:.]+)\s*\}\}/g)].map((m) => m[1] ?? "");
  if (Array.isArray(value)) return value.flatMap(references);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(references);
  return [];
}

function apis(book: Runbook): string[] {
  return book.mainSteps
    .filter((s) => s.action === "aws:executeAwsApi")
    .map((s) => `${String(s.inputs["Service"])}:${String(s.inputs["Api"])}`);
}

for (const name of ["kill.yaml", "unfreeze.yaml"]) {
  test(`${name} is a valid schema 0.3 Automation runbook`, () => {
    const book = load(name);
    assert.equal(book.schemaVersion, "0.3");
    assert.equal(book.assumeRole, "{{ AutomationAssumeRole }}");
    assert.ok(book.description.length > 0);
    assert.equal(book.parameters["AutomationAssumeRole"]?.type, "String");
    for (const [param, spec] of Object.entries(book.parameters)) {
      assert.ok(PARAMETER_TYPES.has(spec.type), `${param} has type ${spec.type}`);
    }
    const names = book.mainSteps.map((s) => s.name);
    assert.equal(new Set(names).size, names.length, "step names are unique");
    for (const step of book.mainSteps) {
      assert.match(step.name, /^[A-Za-z0-9_-]{1,128}$/);
      assert.ok(ACTIONS.has(step.action), `${step.name} uses ${step.action}`);
    }
  });

  test(`${name} declares every parameter it references`, () => {
    const book = load(name);
    const declared = new Set(Object.keys(book.parameters));
    const used = references([book.assumeRole, book.mainSteps]).filter((r) => !r.startsWith("global:"));
    assert.deepEqual(
      used.filter((r) => !declared.has(r)),
      [],
    );
    assert.deepEqual(
      [...declared].filter((p) => !used.includes(p)),
      [],
      "every declared parameter is used",
    );
  });
}

test("kill attaches the deny policy and never detaches it", () => {
  const calls = apis(load("kill.yaml"));
  assert.deepEqual(calls.filter((c) => c === "iam:AttachRolePolicy").length, 2);
  assert.ok(!calls.some((c) => /Detach|Delete|PutRolePolicy/.test(c)), calls.join(", "));
  const script = load("kill.yaml").mainSteps.find((s) => s.action === "aws:executeScript");
  assert.equal(script?.inputs["Runtime"], "python3.11");
  assert.doesNotMatch(String(script?.inputs["Script"]), /start_instances|detach|update_auto_scaling_group/);
});

test("unfreeze detaches the deny policy and starts nothing", () => {
  const book = load("unfreeze.yaml");
  assert.deepEqual(apis(book), ["iam:DetachRolePolicy", "iam:DetachRolePolicy", "ssm:DeleteParameter"]);
  assert.ok(book.mainSteps.every((s) => s.action === "aws:executeAwsApi"));
});
