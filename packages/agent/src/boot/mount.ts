// A4: mount the data volume on /data (part 9 §9.2.3). `mkfs` runs only when two independent facts agree the volume
// is blank: the `rec/formatted` record does not name this volume, and blkid finds no filesystem. When the record says
// formatted but blkid finds nothing (a device not ready yet, a wrong device), the boot fails instead of formatting:
// a failed boot parks the box, a wrong mkfs destroys its data. A filesystem without the record (a restored
// snapshot) is adopted and recorded.
import { RunnerError } from "@dozebox/core/errors";
import type { Clock } from "@dozebox/core/time";
import type { Exec, ExecResult } from "../ports/exec.ts";

export const DATA_MOUNT = "/data";
const DATA_DIRS = [
  { path: "/data/dozebox", mode: "0700" },
  { path: "/data/payloads", mode: "0755" },
  { path: "/data/home", mode: "0755" },
] as const;
const DEVICE_WAIT_MS = 120_000;
const DEVICE_POLL_MS = 2_000;

export type MountOutcome = { readonly formatted: boolean; readonly mountedAt: string };

export type MountDeps = {
  readonly exec: Exec;
  readonly formatted: () => Promise<boolean>;
  readonly markFormatted: () => Promise<void>;
};

const fail = (argv: ReadonlyArray<string>, r: ExecResult): RunnerError =>
  new RunnerError("internal", false, `${argv.join(" ")}: exit ${r.code}: ${r.stderr.trim().slice(0, 300)}`);

async function must(exec: Exec, argv: ReadonlyArray<string>, signal: AbortSignal): Promise<ExecResult> {
  const r = await exec.run(argv, { signal });
  if (r.code !== 0) throw fail(argv, r);
  return r;
}

/**
 * The block device of an attached EBS volume. Nitro machines show `/dev/sdf` as an NVMe device whose by-id name
 * carries the volume id; Xen machines keep `/dev/sdf` or `/dev/xvdf`.
 */
export async function resolveDataDevice(
  deps: { readonly exists: (path: string) => Promise<boolean>; readonly clock: Pick<Clock, "now" | "sleep"> },
  volumeId: string,
  requested: string,
  signal: AbortSignal,
): Promise<string> {
  const candidates = [
    `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${volumeId.replace("-", "")}`,
    requested,
    requested.replace("/dev/sd", "/dev/xvd"),
  ];
  const deadline = deps.clock.now() + DEVICE_WAIT_MS;
  for (;;) {
    for (const c of candidates) if (await deps.exists(c)) return c;
    if (deps.clock.now() >= deadline) {
      throw new RunnerError("internal", true, `no block device for ${volumeId} after ${DEVICE_WAIT_MS / 1000} s`);
    }
    await deps.clock.sleep(DEVICE_POLL_MS, signal);
  }
}

/** blkid's filesystem type, or null when the device holds none (exit 2). */
async function fsType(exec: Exec, device: string, signal: AbortSignal): Promise<string | null> {
  const argv = ["blkid", "-o", "value", "-s", "TYPE", device];
  const r = await exec.run(argv, { signal });
  if (r.code === 2) return null;
  if (r.code !== 0) throw fail(argv, r);
  return r.stdout.trim() || null;
}

/** mkfs only when `rec/formatted` is absent and blkid finds no filesystem; then mount and create the data dirs. */
export async function mountDataVolume(deps: MountDeps, device: string, signal: AbortSignal): Promise<MountOutcome> {
  let formatted = false;
  const mounted = await deps.exec.run(["findmnt", "-n", "-o", "SOURCE", DATA_MOUNT], { signal });
  if (mounted.code !== 0) {
    const type = await fsType(deps.exec, device, signal);
    const recorded = await deps.formatted();
    if (type === null) {
      if (recorded) {
        throw new RunnerError(
          "internal",
          false,
          `refusing mkfs: rec/formatted names this volume but blkid finds no filesystem on ${device}`,
        );
      }
      await must(deps.exec, ["mkfs.ext4", "-q", "-L", "dozebox-data", device], signal);
      formatted = true;
      await deps.markFormatted();
    } else if (!recorded) {
      await deps.markFormatted();
    }
    await must(deps.exec, ["mkdir", "-p", DATA_MOUNT], signal);
    await must(deps.exec, ["mount", "-o", "noatime", device, DATA_MOUNT], signal);
  }
  for (const d of DATA_DIRS) await must(deps.exec, ["install", "-d", "-m", d.mode, d.path], signal);
  return { formatted, mountedAt: DATA_MOUNT };
}
