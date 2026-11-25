// Shared setup for the protocol route tests: the routes over a real store on memfs, with recording fakes.
import assert from "node:assert/strict";
import { makeFakeFs } from "@dozebox/testkit/fakes";
import type { AttentionInput, Status } from "@dozebox/protocol/v1";
import { makeNodeFiles, type FsPromises } from "../src/adapters/files.ts";
import { makeRoutes, type ChangeKind } from "../src/protocol/routes.ts";
import { makeProtocolStore } from "../src/protocol/store.ts";
import type { ProtocolResponse, SocketKind } from "../src/protocol/wire.ts";

export const T0 = Date.parse("2026-11-25T00:00:00.000Z");
export const MIN = 60_000;
export const at = (ms: number): string => new Date(ms).toISOString();

const STATUS: Status = {
  box: {
    id: "box-1",
    phase: "serving",
    since: at(T0),
    instance: { id: "i-1", type: "t4g.small", az: "us-east-1a", lifecycle: "spot" },
    bootedAt: at(T0),
    memoryBytes: 2 ** 31,
    cpus: 2,
    controlUrl: null,
  },
  jail: { ready: true, egress: "off", missing: [] },
  idle: { since: null, sleepAt: null, awakeBecause: [] },
  disk: { level: "ok", freePct: 50, freeBytes: 10, at: at(T0) },
  caps: { awakeSecondsToday: 0, awakeSecondsCap: null },
  holds: [],
  wakes: [],
};

export async function setup() {
  const fake = makeFakeFs();
  const files = makeNodeFiles(fake.fs.promises as unknown as FsPromises, 1);
  const store = await makeProtocolStore({ files, path: "/data/dozebox/protocol.json", bootId: "b" });
  const t = {
    now: T0,
    accepting: true,
    sent: [] as Array<{ payload: string; input: AttentionInput }>,
    sleeps: [] as boolean[],
    sleepAnswer: { accepted: true, blockers: [] as string[] },
    changes: [] as string[],
    statusFor: [] as Array<string | null>,
  };
  const handle = makeRoutes({
    store,
    now: () => t.now,
    payloads: () => ["web", "api"],
    status: (p) => {
      t.statusFor.push(p);
      return STATUS;
    },
    sleep: async (force) => {
      t.sleeps.push(force);
      return t.sleepAnswer;
    },
    attention: async (payload, input) => {
      t.sent.push({ payload, input });
      return `alert-${t.sent.length}`;
    },
    agentVersion: "1.2.3",
    boxId: "box-1",
    features: ["events-sse"],
    holdMaxSeconds: (p) => (p === "api" ? 3600 : 28_800),
    accepting: () => t.accepting,
    onChange: (what: ChangeKind, p) => t.changes.push(`${what}:${p}`),
  });
  const call = (
    method: string,
    path: string,
    body?: unknown,
    opts: { readonly socket?: SocketKind; readonly headers?: Record<string, string> } = {},
  ): Promise<ProtocolResponse> =>
    handle({
      method,
      path,
      query: new URLSearchParams(),
      socket: opts.socket ?? { kind: "payload", payload: "web" },
      headers: opts.headers ?? {},
      body,
      requestId: "r",
    });
  return { t, store, call };
}

export const ADMIN = { kind: "admin" } as const;
export const API = { kind: "payload", payload: "api" } as const;
export const hold = (minutes: number, extra: Record<string, unknown> = {}) => ({
  reason: "work",
  until: at(T0 + minutes * MIN),
  ...extra,
});

export function err(res: ProtocolResponse, status: number, code: string, field?: string): void {
  assert.equal(res.status, status, JSON.stringify(res.body));
  const e = (res.body as { error: { code: string; field?: string; retryable: boolean } }).error;
  assert.equal(e.code, code);
  if (field !== undefined) assert.equal(e.field, field);
}
