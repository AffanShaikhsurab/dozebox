// Rows ported from legacy/runner/test/box/liveness.node-test.ts (decideLiveness). The full legacy file also runs
// against this module through legacy/runner/test/shim (the shim renders the words).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  decideLiveness,
  DRIVER_STALL_MS,
  IDLE_LOOP_STALL_MS,
  NET_DOWN_STRIKES,
  PARK_RETRY_MS,
  TUNNEL_DOWN_MS,
  TUNNEL_RESTARTS_PER_HOUR,
  type Heartbeat,
  type LivenessInput,
  type LivenessState,
} from "../src/health/liveness.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-11-23T10:00:00Z");
const beat = (over: Partial<Heartbeat> = {}): Heartbeat => ({
  at: NOW - 5_000,
  active: 1,
  progressAt: NOW - 30_000,
  ...over,
});
const input = (over: Partial<LivenessInput> = {}): LivenessInput => ({
  now: NOW,
  servedAt: NOW - 60 * MIN,
  hb: beat(),
  net: true,
  tunnel: { expected: false },
  state: {},
  ...over,
});
const keys = (r: { actions: ReadonlyArray<{ kind: string; key: string }> }) =>
  r.actions.map((a) => `${a.kind}:${a.key}`);
const loops = { watcherAt: NOW - MIN, idleAt: NOW - 30_000, alertsAt: NOW - MIN, shellsAt: NOW - 30_000 };

const rows: ReadonlyArray<{ name: string; input: Partial<LivenessInput>; expect: string[] }> = [
  { name: "work reconciled: nothing", input: {}, expect: [] },
  { name: "no work active: nothing", input: { hb: beat({ active: 0, progressAt: null }) }, expect: [] },
  { name: "no heartbeat: nothing", input: { hb: null }, expect: [] },
  {
    name: "work quiet just under 15 min: nothing",
    input: { hb: beat({ progressAt: NOW - (DRIVER_STALL_MS - 1) }) },
    expect: [],
  },
  {
    name: "work quiet 15 min: restart",
    input: { hb: beat({ progressAt: NOW - DRIVER_STALL_MS }) },
    expect: ["restart-server:server-restart"],
  },
  {
    name: "heartbeat stopped 15 min ago: restart",
    input: { hb: beat({ at: NOW - DRIVER_STALL_MS, progressAt: NOW - DRIVER_STALL_MS }) },
    expect: ["restart-server:server-restart"],
  },
  {
    name: "a fresh serve gives the full window",
    input: { servedAt: NOW - 2 * MIN, hb: beat({ at: NOW - 40 * MIN, progressAt: NOW - 40 * MIN }) },
    expect: [],
  },
  {
    name: "a restart 5 min ago gives the full window",
    input: { hb: beat({ progressAt: NOW - 40 * MIN }), state: { serverRestarts: [NOW - 5 * MIN] } },
    expect: [],
  },
  {
    name: "idle loop quiet 5 min: restart",
    input: { hb: beat({ active: 0, ticks: { ...loops, idleAt: NOW - IDLE_LOOP_STALL_MS } }) },
    expect: ["restart-server:server-restart"],
  },
  {
    name: "idle loop quiet 4 min: nothing",
    input: { hb: beat({ active: 0, ticks: { ...loops, idleAt: NOW - 4 * MIN } }) },
    expect: [],
  },
  {
    name: "watcher is judged only while work is active",
    input: { hb: beat({ active: 0, ticks: { ...loops, watcherAt: NOW - 20 * MIN } }) },
    expect: [],
  },
  {
    name: "a lost network suppresses every loop check",
    input: { net: false, hb: beat({ active: 0, ticks: { ...loops, idleAt: NOW - 20 * MIN } }) },
    expect: [],
  },
  {
    name: "tunnel down 10 min with a client: kick it",
    input: {
      tunnel: { expected: true, pid: 77, roundTrip: false, cause: "silent" },
      state: { tunnelDownSince: NOW - TUNNEL_DOWN_MS },
    },
    expect: ["restart-tunnel:tunnel-kick"],
  },
  {
    name: "tunnel that never worked and has no client: nothing",
    input: { tunnel: { expected: true, pid: null, roundTrip: false }, state: { tunnelDownSince: NOW - 20 * MIN } },
    expect: [],
  },
  {
    name: "tunnel that worked and has no client: restart the payload",
    input: {
      tunnel: { expected: true, pid: null, roundTrip: false },
      state: { tunnelDownSince: NOW - 20 * MIN, tunnelLastOkAt: NOW - 30 * MIN },
    },
    expect: ["restart-server:server-restart"],
  },
  {
    name: "tunnel restarts spent and nobody here for 30 min: park",
    input: {
      hb: beat({ presenceAt: NOW - 30 * MIN }),
      tunnel: { expected: true, pid: 77, roundTrip: false, cause: "silent" },
      state: { tunnelDownSince: NOW - 40 * MIN, tunnelRestarts: [NOW - 30 * MIN, NOW - 20 * MIN, NOW - 10 * MIN] },
    },
    expect: ["park:tunnel-park"],
  },
  {
    name: "tunnel restarts spent and someone here: alert stuck",
    input: {
      hb: beat({ presenceAt: NOW - 5 * MIN }),
      tunnel: { expected: true, pid: 77, roundTrip: false, cause: "silent" },
      state: { tunnelDownSince: NOW - 40 * MIN, tunnelRestarts: [NOW - 30 * MIN, NOW - 20 * MIN, NOW - 10 * MIN] },
    },
    expect: ["alert:tunnel-stuck"],
  },
  {
    name: "tunnel works again after a kick: tunnel-back",
    input: {
      tunnel: { expected: true, pid: 77, roundTrip: true },
      state: { alerts: { "tunnel-kick": NOW - 5 * MIN } },
    },
    expect: ["alert:tunnel-back"],
  },
];

for (const row of rows) {
  test(`decideLiveness: ${row.name}`, () => {
    assert.deepEqual(keys(decideLiveness(input(row.input))), row.expect);
  });
}

test("restarts at most twice an hour, then alerts once and stays quiet until the fault clears", () => {
  let state: Partial<LivenessState> = {};
  for (let i = 1; i <= 2; i += 1) {
    const t = NOW + i * 20 * MIN;
    const r = decideLiveness(
      input({ now: t, servedAt: NOW - 90 * MIN, hb: beat({ at: t - 5_000, progressAt: NOW - 40 * MIN }), state }),
    );
    assert.deepEqual(keys(r), ["restart-server:server-restart"]);
    assert.deepEqual(r.actions[0]?.facts, {
      why: { code: "work-stalled", minutes: i === 1 ? 60 : 20, active: 1 },
      restarts: i,
      limit: 2,
    });
    state = r.state;
  }
  const t = NOW + 60 * MIN;
  const stuck = decideLiveness(
    input({ now: t, servedAt: NOW - 90 * MIN, hb: beat({ at: t - 5_000, progressAt: NOW - 40 * MIN }), state }),
  );
  assert.deepEqual(keys(stuck), ["alert:server-stuck"]);
  const later = NOW + 8 * 60 * MIN;
  const quiet = decideLiveness(
    input({
      now: later,
      servedAt: NOW - 90 * MIN,
      hb: beat({ at: later - 5_000, progressAt: NOW - 40 * MIN }),
      state: stuck.state,
    }),
  );
  assert.deepEqual(quiet.actions, []);
  const recovered = decideLiveness(
    input({ now: later + MIN, hb: beat({ at: later, progressAt: later }), state: quiet.state }),
  );
  assert.equal(recovered.state.serverGaveUp, false);
});

test("parks once when the idle loop stays dead after two restarts, and asks again after ten minutes", () => {
  const hb = beat({ active: 0, ticks: { ...loops, idleAt: NOW - 30 * MIN } });
  const state = { serverRestarts: [NOW - 30 * MIN, NOW - 20 * MIN] };
  const park = decideLiveness(input({ hb, state }));
  assert.deepEqual(keys(park), ["park:idle-loop-park"]);
  const soon = decideLiveness(input({ now: NOW + MIN, hb: { ...hb, at: NOW + MIN - 5_000 }, state: park.state }));
  assert.deepEqual(soon.actions, []);
  const retry = NOW + PARK_RETRY_MS;
  const again = decideLiveness(input({ now: retry, hb: { ...hb, at: retry - 5_000 }, state: soon.state }));
  assert.deepEqual(keys(again), ["park:idle-loop-park"]);
});

test("network: lost after three ticks, told once, back told once", () => {
  let state: Partial<LivenessState> = {};
  const seen: string[][] = [];
  for (let i = 0; i < NET_DOWN_STRIKES + 2; i += 1) {
    const r = decideLiveness(input({ now: NOW + i * MIN, net: false, state }));
    seen.push(keys(r));
    state = r.state;
  }
  assert.deepEqual(seen, [[], [], ["alert:net-down"], [], []]);
  const back = decideLiveness(input({ now: NOW + 10 * MIN, state }));
  assert.deepEqual(keys(back), ["alert:net-back"]);
  assert.deepEqual(back.actions[0]?.facts, { minutes: 10 });
  assert.equal(back.state.netStrikes, 0);
});

test("tunnel kicks keep five minutes apart and stop after three an hour", () => {
  const tunnel = { expected: true, pid: 77, roundTrip: false, cause: "silent" };
  let state: Partial<LivenessState> = { tunnelDownSince: NOW - TUNNEL_DOWN_MS };
  const out: string[][] = [];
  for (let i = 0; i <= 20; i += 1) {
    const r = decideLiveness(input({ now: NOW + i * MIN, tunnel, hb: beat({ active: 0, presenceAt: NOW }), state }));
    out.push(keys(r));
    state = r.state;
  }
  const kicks = out.flat().filter((k) => k === "restart-tunnel:tunnel-kick").length;
  assert.equal(kicks, TUNNEL_RESTARTS_PER_HOUR);
  assert.deepEqual(out[0], ["restart-tunnel:tunnel-kick"]);
  assert.deepEqual(out[4], []);
  assert.deepEqual(out[5], ["restart-tunnel:tunnel-kick"]);
  assert.deepEqual(out[11], ["alert:tunnel-stuck"]);
  assert.deepEqual(out.slice(12).flat(), []);
});
