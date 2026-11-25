// A4: the boot timeline (part 4 §4.14 `rec/boot-timeline`). Stage 0 (bash), `dozebox-boot` and `dozeboxd` each append
// their steps to one JSON-lines file under /run/dozebox, so the record covers the whole boot although three processes
// measure it. dozeboxd publishes it when the box serves; dozebox-boot publishes it when the boot fails.
import type { Clock } from "@dozebox/core/time";
import type { Files } from "../ports/files.ts";
import type { RecordPublisher } from "../records/publish.ts";

export const TIMELINE_PATH = "/run/dozebox/boot-timeline.jsonl";
export const UPTIME_PATH = "/proc/uptime";
const MAX_STEPS = 24;
const STEP = /^[a-z][a-z0-9-]{0,40}$/;

export type TimelineStep = {
  readonly step: string;
  /** Epoch ms. */
  readonly startedAt: number;
  readonly ms: number;
  readonly ok: boolean;
};

export interface BootTimeline {
  /** Time `fn` as `step`; a throw is recorded as not ok and rethrown. */
  readonly step: <T>(step: string, fn: () => Promise<T>) => Promise<T>;
  /** Every step in the file plus this process's, in start order. */
  readonly steps: () => Promise<ReadonlyArray<TimelineStep>>;
  /** Write `rec/boot-timeline`. */
  readonly publish: () => Promise<void>;
}

export type BootTimelineDeps = {
  readonly clock: Pick<Clock, "now">;
  readonly records: Pick<RecordPublisher, "put">;
  readonly files: Pick<Files, "readText" | "writeAtomic">;
  /** Epoch ms of the kernel's boot (now minus /proc/uptime). */
  readonly bootAt: number;
  readonly path?: string;
};

/** Boot time from `/proc/uptime` ("12345.67 ..."), or `now` when it cannot be read. */
export async function bootTimeOf(files: Pick<Files, "readText">, now: number): Promise<number> {
  const text = await files.readText(UPTIME_PATH).catch(() => null);
  const up = Number(text?.trim().split(/\s+/)[0]);
  return Number.isFinite(up) && up >= 0 ? now - Math.round(up * 1000) : now;
}

export function parseSteps(text: string | null): TimelineStep[] {
  const out: TimelineStep[] = [];
  for (const line of (text ?? "").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v = JSON.parse(line) as Partial<TimelineStep> | null;
      if (
        typeof v?.step === "string" &&
        STEP.test(v.step) &&
        typeof v.startedAt === "number" &&
        typeof v.ms === "number" &&
        typeof v.ok === "boolean"
      ) {
        out.push({ step: v.step, startedAt: v.startedAt, ms: Math.max(0, Math.round(v.ms)), ok: v.ok });
      }
    } catch {
      // A torn or foreign line is skipped: the timeline is a diagnostic, never a reason to fail a boot.
    }
  }
  return out;
}

export function makeBootTimeline(deps: BootTimelineDeps): BootTimeline {
  const path = deps.path ?? TIMELINE_PATH;
  const read = async (): Promise<TimelineStep[]> => parseSteps(await deps.files.readText(path).catch(() => null));

  const append = async (s: TimelineStep): Promise<void> => {
    try {
      const text = (await deps.files.readText(path)) ?? "";
      const sep = text === "" || text.endsWith("\n") ? "" : "\n";
      await deps.files.writeAtomic(path, `${text}${sep}${JSON.stringify(s)}\n`);
    } catch {
      // Same as above: losing a timeline line must not fail the step it measured.
    }
  };

  const steps = async (): Promise<ReadonlyArray<TimelineStep>> =>
    (await read()).toSorted((a, b) => a.startedAt - b.startedAt);

  return {
    step: async (step, fn) => {
      if (!STEP.test(step)) throw new Error(`"${step}" is not a timeline step name`);
      const startedAt = deps.clock.now();
      try {
        const v = await fn();
        await append({ step, startedAt, ms: deps.clock.now() - startedAt, ok: true });
        return v;
      } catch (e) {
        await append({ step, startedAt, ms: deps.clock.now() - startedAt, ok: false });
        throw e;
      }
    },
    steps,
    publish: async () => {
      const all = await steps();
      const up = (ms: number): number => Math.max(0, Math.round((ms - deps.bootAt) / 100) / 10);
      await deps.records.put("rec/boot-timeline", {
        upSeconds: up(deps.clock.now()),
        ok: all.every((s) => s.ok),
        steps: all.slice(-MAX_STEPS).map((s) => ({
          step: s.step,
          ms: s.ms,
          upStart: up(s.startedAt),
          upEnd: up(s.startedAt + s.ms),
        })),
      });
    },
  };
}
