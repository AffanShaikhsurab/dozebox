// Linux host facts: statfs, `/sys/class/net/<if>/statistics/tx_bytes`, and a TCP connect probe to port 443.
import { connect as netConnect } from "node:net";
import type { HostStats } from "../ports/host.ts";

export type HostFs = {
  readonly statfs: (
    path: string,
  ) => Promise<{ readonly bavail: number; readonly bsize: number; readonly blocks: number }>;
  readonly readdir: (path: string) => Promise<string[]>;
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
};

export type Connect = (host: string, port: number, signal: AbortSignal) => Promise<void>;

const NET_DIR = "/sys/class/net";

const nodeConnect: Connect = (host, port, signal) =>
  new Promise<void>((resolve, reject) => {
    const socket = netConnect({ host, port, signal });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });

export function makeLinuxHostStats(deps: { readonly fs: HostFs; readonly connect?: Connect }): HostStats {
  const connect = deps.connect ?? nodeConnect;
  return {
    space: async (path) => {
      const s = await deps.fs.statfs(path);
      return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
    },
    txBytes: async () => {
      let sum = 0;
      for (const name of await deps.fs.readdir(NET_DIR)) {
        if (name === "lo") continue;
        try {
          const n = Number((await deps.fs.readFile(`${NET_DIR}/${name}/statistics/tx_bytes`, "utf8")).trim());
          if (Number.isFinite(n)) sum += n;
        } catch {
          // an interface without the counter is skipped
        }
      }
      return sum;
    },
    reach: async (host, signal) => {
      try {
        await connect(host, 443, signal);
        return true;
      } catch {
        return false;
      }
    },
  };
}
