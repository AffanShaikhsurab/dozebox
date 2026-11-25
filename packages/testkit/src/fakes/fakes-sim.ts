// Fakes for the sim-infra lane: an in-memory DozeboxClient (P2) for payload-side tests, the CLI's box commands and
// the simulator's agent model. Holds and wakes are kept in maps; events are pushed by the test with `emit`.
import type { DozeboxClient, DozeboxEvent } from "@dozebox/client";

type Status = Awaited<ReturnType<DozeboxClient["status"]>>;
type Hold = Awaited<ReturnType<DozeboxClient["hold"]>>;
type Wake = Awaited<ReturnType<DozeboxClient["wake"]>>;

export type FakeDozeboxClient = DozeboxClient & {
  readonly holds: Map<string, Parameters<DozeboxClient["hold"]>[1]>;
  /** Holds kept alive with `keepHold`, by id, until their stop(). */
  readonly kept: Map<string, Parameters<DozeboxClient["keepHold"]>[1]>;
  readonly wakes: Map<string, Parameters<DozeboxClient["wake"]>[1]>;
  readonly beats: Array<Parameters<DozeboxClient["beat"]>[0][number]>;
  readonly attentions: Array<Parameters<DozeboxClient["attention"]>[0]>;
  sleepBlockers: string[];
  readonly emit: (e: DozeboxEvent) => void;
};

/**
 * `status`, `hello`, `hold`, `wake` and `attention` answer from `answers` (the test supplies protocol fixtures);
 * the rest only records.
 */
export function makeFakeDozeboxClient(answers: {
  readonly status: () => Status;
  readonly hello: () => Awaited<ReturnType<DozeboxClient["hello"]>>;
  readonly hold: (id: string) => Hold;
  readonly wake: (id: string) => Wake;
  readonly attention: () => Awaited<ReturnType<DozeboxClient["attention"]>>;
}): FakeDozeboxClient {
  const listeners = new Set<(e: DozeboxEvent) => void>();
  const f: FakeDozeboxClient = {
    holds: new Map(),
    kept: new Map(),
    wakes: new Map(),
    beats: [],
    attentions: [],
    sleepBlockers: [],
    emit: (e) => listeners.forEach((l) => l(e)),
    hello: async () => answers.hello(),
    status: async () => answers.status(),
    hold: async (id, input) => (f.holds.set(id, input), answers.hold(id)),
    release: async (id) => void f.holds.delete(id),
    keepHold: (id, opts) => {
      f.kept.set(id, opts);
      return { stop: async () => void f.kept.delete(id) };
    },
    beat: async (beats) => void f.beats.push(...beats),
    wake: async (id, input) => (f.wakes.set(id, input), answers.wake(id)),
    cancelWake: async (id) => void f.wakes.delete(id),
    presence: async () => {},
    attention: async (input) => (f.attentions.push(input), answers.attention()),
    sleep: async (opts) =>
      opts?.force || f.sleepBlockers.length === 0
        ? { accepted: true, blockers: [] }
        : { accepted: false, blockers: [...f.sleepBlockers] },
    events: (onEvent) => {
      listeners.add(onEvent);
      return { close: () => void listeners.delete(onEvent) };
    },
  };
  return f;
}
