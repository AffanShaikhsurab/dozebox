// Runs seeds in worker threads: a seed never depends on another, so the worker count never changes a result.
import { availableParallelism } from "node:os";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { censusOf, runSeed, type Census, type SimOptions, type SimRun } from "../src/run.ts";

type Job = { readonly from: number; readonly count: number; readonly opts: SimOptions };

export function defaultWorkers(): number {
  return Math.max(1, Math.min(8, availableParallelism() - 1));
}

/** All runs of `count` seeds from `from`, in seed order. */
export async function runSeeds(
  from: number,
  count: number,
  opts: SimOptions,
  workers = defaultWorkers(),
): Promise<SimRun[]> {
  if (workers <= 1 || count < 50) return Array.from({ length: count }, (_, i) => runSeed(from + i, opts));
  const chunk = Math.ceil(count / workers);
  const parts = await Promise.all(
    Array.from({ length: workers }, (_, i) => {
      const start = from + i * chunk;
      const n = Math.max(0, Math.min(chunk, from + count - start));
      if (n === 0) return Promise.resolve<SimRun[]>([]);
      return new Promise<SimRun[]>((resolve, reject) => {
        const job: Job = { from: start, count: n, opts };
        const worker = new Worker(new URL(import.meta.url), { workerData: job });
        worker.once("message", (runs: SimRun[]) => resolve(runs));
        worker.once("error", reject);
      });
    }),
  );
  return parts.flat();
}

export async function census(
  from: number,
  count: number,
  opts: SimOptions,
  workers?: number,
): Promise<{ census: Census; runs: SimRun[] }> {
  const runs = await runSeeds(from, count, opts, workers);
  return { census: censusOf(runs), runs };
}

if (!isMainThread && parentPort !== null) {
  const job = workerData as Job;
  const runs = Array.from({ length: job.count }, (_, i) => runSeed(job.from + i, job.opts));
  parentPort.postMessage(runs, []);
}
