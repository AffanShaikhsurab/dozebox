// A2: the built-in presence sources (plugin point 4, part 5 §5.6), sampled every 30 s by the protocol server. Both
// read established TCP connections from /proc/net/tcp and tcp6: an SSH session (local port 22) is `interactive`
// presence `src:ssh`; a connection to one of `activity.tcpPorts` is `viewing` presence `src:tcp:<port>`.
import type { PresenceSample, PresenceSource } from "../ports/presence.ts";

const TCP_FILES = ["/proc/net/tcp", "/proc/net/tcp6"];
const ESTABLISHED = "01";
/** A sample counts this long; the next sample (30 s later) renews it. */
export const SOURCE_PRESENCE_MS = 90_000;

/** Pure: local ports with at least one established connection, from the text of /proc/net/tcp or tcp6. */
export function establishedLocalPorts(text: string): Set<number> {
  const ports = new Set<number>();
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    const local = cols[1];
    if (local === undefined || cols[3] !== ESTABLISHED) continue;
    const port = Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 16);
    if (Number.isInteger(port)) ports.add(port);
  }
  return ports;
}

type ReadFile = (path: string) => Promise<string>;

async function livePorts(read: ReadFile): Promise<Set<number>> {
  const all = new Set<number>();
  for (const f of TCP_FILES) {
    try {
      for (const p of establishedLocalPorts(await read(f))) all.add(p);
    } catch {
      // tcp6 is missing on hosts without IPv6
    }
  }
  return all;
}

export function sshPresenceSource(deps: { readonly read: ReadFile; readonly port?: number }): PresenceSource {
  return {
    id: "ssh",
    sample: async (now): Promise<ReadonlyArray<PresenceSample>> =>
      (await livePorts(deps.read)).has(deps.port ?? 22)
        ? [{ id: "src:ssh", kind: "interactive", until: now + SOURCE_PRESENCE_MS }]
        : [],
  };
}

export function tcpPresenceSource(deps: {
  readonly read: ReadFile;
  readonly ports: () => ReadonlyArray<number>;
}): PresenceSource {
  return {
    id: "tcp",
    sample: async (now): Promise<ReadonlyArray<PresenceSample>> => {
      const want = deps.ports();
      if (want.length === 0) return [];
      const live = await livePorts(deps.read);
      return want
        .filter((p) => live.has(p))
        .map((p) => ({ id: `src:tcp:${p}`, kind: "viewing" as const, until: now + SOURCE_PRESENCE_MS }));
    },
  };
}
