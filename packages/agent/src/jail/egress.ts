// A8: per-uid nftables egress for agent users (part 8 §8.4). Both modes drop IMDS (IPv4 and IPv6) for agent uids.
// `allowlist` also drops everything except loopback, the VPC resolver and the resolved allow set. One `nft -f` file
// replaces the whole table atomically; a failed load leaves the old rules and refuses to start payloads (fail closed).
import { isIP } from "node:net";
import { RunnerError } from "@dozebox/core/errors";
import type { Loop } from "../loops.ts";
import type { Exec } from "../ports/exec.ts";
import type { Files } from "../ports/files.ts";
import type { JailConfig } from "./types.ts";

export const NFT_TABLE = "dozebox_egress";
export const NFT_FILE = "/etc/dozebox/egress.nft";
export const EGRESS_REFRESH_MS = 5 * 60_000;
const IMDS4 = "169.254.169.254";
const IMDS6 = "fd00:ec2::254";
const VPC_DNS = "169.254.169.253";

const set = (name: string, type: string, items: ReadonlyArray<string>): string[] => [
  `  set ${name} {`,
  `    type ${type}`,
  ...(items.length === 0 ? [] : [`    elements = { ${items.join(", ")} }`]),
  "  }",
];

/** Pure: the nftables ruleset text for the payload uids. `resolved` are the IPs of `allowHosts`. */
export function renderNftRules(cfg: JailConfig, uids: ReadonlyArray<number>, resolved: ReadonlyArray<string>): string {
  for (const u of uids) if (!Number.isInteger(u) || u < 60_000) throw new TypeError(`agent uid ${u} is below 60000`);
  for (const ip of resolved) if (isIP(ip) === 0) throw new TypeError(`"${ip}" is not an IP address`);
  const head = [`table inet ${NFT_TABLE} {}`, `delete table inet ${NFT_TABLE}`, `table inet ${NFT_TABLE} {`];
  const lines = [...head];
  const sorted = [...new Set(uids)].toSorted((a, b) => a - b);
  if (cfg.enabled && sorted.length > 0) {
    const allow = cfg.egress === "allowlist";
    const v4 = [...new Set(resolved.filter((ip) => isIP(ip) === 4))].toSorted();
    const v6 = [...new Set(resolved.filter((ip) => isIP(ip) === 6))].toSorted();
    lines.push(...set("agents", "uid", sorted.map(String)));
    if (allow) lines.push(...set("allow4", "ipv4_addr", v4), ...set("allow6", "ipv6_addr", v6));
    lines.push(
      "  chain output {",
      "    type filter hook output priority filter; policy accept;",
      `    meta skuid @agents ip daddr ${IMDS4} drop`,
      `    meta skuid @agents ip6 daddr ${IMDS6} drop`,
    );
    if (allow) {
      lines.push(
        '    meta skuid @agents oifname "lo" accept',
        `    meta skuid @agents ip daddr ${VPC_DNS} meta l4proto { tcp, udp } th dport 53 accept`,
        "    meta skuid @agents ip daddr @allow4 accept",
        "    meta skuid @agents ip6 daddr @allow6 accept",
        "    meta skuid @agents reject with icmpx type admin-prohibited",
      );
    }
    lines.push("  }");
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

/** Load the ruleset with `nft -f`; refuses to start payloads when loading fails (fail closed). */
export async function applyEgress(
  deps: { readonly exec: Exec; readonly files: Files },
  rules: string,
  signal: AbortSignal,
): Promise<void> {
  await deps.files.writeAtomic(NFT_FILE, rules);
  const res = await deps.exec.run(["nft", "-f", NFT_FILE], { signal });
  if (res.code !== 0) {
    throw new RunnerError("internal", false, `nft -f ${NFT_FILE} failed (${res.code}): ${res.stderr.slice(0, 300)}`);
  }
}

/** IPs of `hosts`: literal IPs as they are, names through `lookup`; a name that does not resolve is left out. */
export async function resolveAllowHosts(
  hosts: ReadonlyArray<string>,
  lookup: (host: string) => Promise<ReadonlyArray<string>>,
): Promise<string[]> {
  const out = await Promise.all(
    hosts.map(async (h) => {
      if (isIP(h) !== 0) return [h];
      try {
        return (await lookup(h)).filter((ip) => isIP(ip) !== 0);
      } catch {
        return [];
      }
    }),
  );
  return [...new Set(out.flat())].toSorted();
}

/** Every 5 min: resolve the allow hosts and reload the table when the text changed. */
export function egressLoop(deps: {
  readonly exec: Exec;
  readonly files: Files;
  readonly config: () => JailConfig;
  readonly uids: () => ReadonlyArray<number>;
  readonly lookup: (host: string) => Promise<ReadonlyArray<string>>;
  readonly onApplied?: (rules: string) => void;
}): Loop {
  let last: string | null = null;
  return {
    name: "egress",
    everyMs: EGRESS_REFRESH_MS,
    immediate: true,
    tick: async (signal) => {
      const cfg = deps.config();
      const ips = cfg.enabled && cfg.egress === "allowlist" ? await resolveAllowHosts(cfg.allowHosts, deps.lookup) : [];
      const rules = renderNftRules(cfg, deps.uids(), ips);
      if (rules === last) return;
      await applyEgress(deps, rules, signal);
      last = rules;
      deps.onApplied?.(rules);
    },
  };
}
