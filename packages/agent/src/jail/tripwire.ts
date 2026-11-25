// A8: the tripwire (part 8 Â§8.5). A decoy AWS profile whose `credential_process` is the tripwire helper; the helper
// reports to the loopback socket 127.0.0.1:7311 (`dozebox-tripwire.socket`, Accept=yes), whose per-connection
// service appends one line to the hits file. The agent reads new lines and pages with key `tripwire:<context>`.
import type { Files } from "../ports/files.ts";
import { DECOY_CONFIG } from "./bwrap.ts";

export const TRIPWIRE_PORT = 7311;
export const TRIPWIRE_HELPER = "/opt/dozebox/current/bin/dozebox-tripwire";
export const TRIPWIRE_HITS = "/var/lib/dozebox/tripwire/hits.jsonl";
const MAX_HITS_KEPT = 200;

export type TripwireHit = { readonly at: number; readonly what: "decoy-key" | "decoy-socket"; readonly detail: string };

export interface Tripwire {
  readonly arm: () => Promise<void>;
  /** Hits since the last call; each pages with context. */
  readonly hits: () => Promise<ReadonlyArray<TripwireHit>>;
}

/** Pure: the decoy profile. Any SDK that loads it runs the helper, which reports and returns no credentials. */
export function renderDecoyConfig(region: string): string {
  return ["[default]", `region = ${region}`, `credential_process = ${TRIPWIRE_HELPER}`, ""].join("\n");
}

/** The systemd socket and its per-connection service. */
export const TRIPWIRE_UNITS = {
  "dozebox-tripwire.socket": [
    "[Unit]",
    "Description=dozebox tripwire",
    "[Socket]",
    `ListenStream=127.0.0.1:${TRIPWIRE_PORT}`,
    "Accept=yes",
    "MaxConnections=16",
    "[Install]",
    "WantedBy=sockets.target",
    "",
  ].join("\n"),
  "dozebox-tripwire@.service": [
    "[Unit]",
    "Description=dozebox tripwire report",
    "[Service]",
    `ExecStart=${TRIPWIRE_HELPER} --report`,
    "StandardInput=socket",
    "StandardOutput=journal",
    "RuntimeMaxSec=10",
    "",
  ].join("\n"),
} as const;

const SAFE = /[^A-Za-z0-9._:@/ -]/g;

/**
 * Pure: the line the report service appends for what one connection sent. The helper sends `decoy-key <context>`;
 * anything else (a scan, a stray client) is a `decoy-socket` hit. The text is untrusted: cut and reduced to safe
 * characters.
 */
export function hitLine(received: string, now: number): string {
  const first = received.split("\n", 1)[0] ?? "";
  const m = /^decoy-key (\S{1,64})$/.exec(first.trim());
  const hit: TripwireHit = m
    ? { at: now, what: "decoy-key", detail: `context=${(m[1] ?? "").replace(SAFE, "_")}` }
    : { at: now, what: "decoy-socket", detail: `sent=${first.slice(0, 80).replace(SAFE, "_")}` };
  return `${JSON.stringify(hit)}\n`;
}

const isHit = (v: unknown): v is TripwireHit => {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["at"] === "number" &&
    (r["what"] === "decoy-key" || r["what"] === "decoy-socket") &&
    typeof r["detail"] === "string"
  );
};

/** The alert key a hit pages with. */
export function tripwireKey(hit: TripwireHit): string {
  const ctx = /^context=(.+)$/.exec(hit.detail)?.[1];
  return hit.what === "decoy-key" && ctx !== undefined ? `tripwire:${ctx}` : "tripwire:socket";
}

export function makeTripwire(deps: {
  readonly files: Files;
  readonly now: () => number;
  /** The decoy must be readable by agent users (writeAtomic writes 0600). */
  readonly chmod: (path: string, mode: number) => Promise<void>;
  readonly region?: string;
  readonly hitsPath?: string;
}): Tripwire {
  const path = deps.hitsPath ?? TRIPWIRE_HITS;
  let seen = 0;
  return {
    arm: async () => {
      await deps.files.writeAtomic(DECOY_CONFIG, renderDecoyConfig(deps.region ?? "us-east-1"));
      await deps.chmod(DECOY_CONFIG, 0o644);
      const text = await deps.files.readText(path);
      seen = text === null ? 0 : text.split("\n").filter((l) => l !== "").length;
    },
    hits: async () => {
      const lines = ((await deps.files.readText(path)) ?? "").split("\n").filter((l) => l !== "");
      if (lines.length < seen) seen = 0;
      const fresh = lines.slice(seen);
      seen = lines.length;
      if (lines.length > MAX_HITS_KEPT) {
        const kept = lines.slice(-MAX_HITS_KEPT);
        await deps.files.writeAtomic(path, `${kept.join("\n")}\n`);
        seen = kept.length;
      }
      return fresh.flatMap((l) => {
        try {
          const v: unknown = JSON.parse(l);
          return isHit(v) ? [v] : [];
        } catch {
          return [];
        }
      });
    },
  };
}

/** The page a hit sends (part 8 §8.5), with the jail exec context so the operator knows which agent did it. */
export function tripwireAlert(hit: TripwireHit): {
  readonly key: string;
  readonly severity: "page";
  readonly title: string;
  readonly body: string;
} {
  const what =
    hit.what === "decoy-key" ? "the decoy AWS profile was used" : "something connected to the tripwire socket";
  return {
    key: tripwireKey(hit),
    severity: "page",
    title: "Tripwire: a jailed agent reached for credentials",
    body: `${what} at ${new Date(hit.at).toISOString()} (${hit.detail}).`,
  };
}
