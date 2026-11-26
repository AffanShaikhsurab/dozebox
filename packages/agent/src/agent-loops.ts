// The agent's services, built once after the first config load (run.ts `prepare`): one phase, one supervisor, the
// protocol store and server (A2), the coalescing record publisher and the alert forwarder (A7), and the loops that
// share them. The core loops (A3/A5) live here; agent-view.ts builds status and liveness.
//
// - payloads: (re)start every payload when the config's definitions change (immediately, then every 5 minutes).
// - health:   checks and strikes; the first healthy check writes `rec/serving` and publishes the boot timeline.
// - idle:     the idle verdict over the protocol store's holds and presence; parks with reason `idle`.
// - spot, disk, net, logs (A6/A7), alerts (retry), liveness, and with the jail on: egress, tripwire (A8).
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { RunnerError } from "@dozebox/core/errors";
import type { IdleVerdict } from "@dozebox/core/idle";
import { MINUTE, toInstant } from "@dozebox/core/time";
import { makeAlertForwarder } from "./alerts/index.ts";
import { buildLiveness, buildStatus } from "./agent-view.ts";
import { bootTimeOf, makeBootTimeline } from "./boot/timeline.ts";
import type { ConfigLoader } from "./config/load.ts";
import type { Deps } from "./deps.ts";
import { diskLoop, type DiskReading } from "./disk/index.ts";
import { messageOf } from "./errors.ts";
import { makeActivitySampler } from "./idle/activity.ts";
import { idleLoop } from "./idle/loop.ts";
import { park } from "./idle/park.ts";
import { jailLoops } from "./jail-loops.ts";
import { jailReadiness, type JailReadiness } from "./jail/index.ts";
import type { Loop } from "./loops.ts";
import { logShipLoop, makeJournalReader } from "./logs/index.ts";
import { makeLinuxHostStats, netLoop, type NetState } from "./net/index.ts";
import { canPark, makePhaseCell, type ParkReason } from "./phase.ts";
import type { HostStats, SpotNotices } from "./ports/host.ts";
import type { HealthResult, PayloadSupervisor } from "./ports/payloads.ts";
import {
  makeProtocolServer,
  makeProtocolStore,
  sshPresenceSource,
  tcpPresenceSource,
  type ProtocolServer,
  type ProtocolServerDeps,
} from "./protocol/index.ts";
import { makeCoalescingPublisher } from "./records/index.ts";
import type { Prepare } from "./run.ts";
import { DEFAULT_STOP_GRACE_SECONDS, makeImdsSpotNotices, makeReclaim, spotLoop } from "./spot/index.ts";
import { ensureAgentUser, ensureUser, makeSupervisor, parsePasswd } from "./supervisor/index.ts";
import { healthLoop } from "./watchdog/health.ts";

export const RUN_DIR = "/run/dozebox";
const PAYLOADS_EVERY_MS = 5 * MINUTE;
const LIVENESS_OFFER_MS = 30_000;
const JAIL_READY_EVERY_MS = 30_000;
const read = (path: string): Promise<string> => fsp.readFile(path, "utf8");
const capSeconds = (hours: number | null): number | null => (hours === null ? null : hours * 3600);
const PROBE_HOSTS = ["ssm.amazonaws.com", "github.com"] as const;

export type AgentOptions = {
  readonly version?: string;
  /** Tests inject these; production builds them from deps. */
  readonly supervisor?: (deps: Deps, config: ConfigLoader) => PayloadSupervisor;
  readonly server?: (d: ProtocolServerDeps) => ProtocolServer;
  readonly spotNotices?: SpotNotices;
  readonly hostStats?: HostStats;
  readonly journal?: Parameters<typeof logShipLoop>[0]["read"];
  readonly jail?: (deps: Deps) => Promise<JailReadiness>;
};

export function makeAgent(opts: AgentOptions = {}): Prepare {
  return async (deps, config) => {
    const log = deps.log.child({ component: "agent" });
    const now = deps.clock.now;
    const box = () => config.current().box;
    const defOf = (p: string) => config.current().payloads.find((d) => d.name === p);
    let server: ProtocolServer | null = null;
    const publish = (name: string, data: unknown): void => server?.publish(name, data);
    const signal = new AbortController();

    const phase = makePhaseCell({ phase: "booting", since: now() }, (p) => {
      publish("phase", { phase: p.phase, since: toInstant(p.since) });
      void deps.files.writeAtomic(`${RUN_DIR}/phase`, `${p.phase}\n`).catch((e: unknown) => {
        log.log("warn", "could not write the phase file", { error: e });
      });
    });
    const supervisor =
      opts.supervisor?.(deps, config) ??
      makeSupervisor({
        exec: deps.exec,
        files: deps.files,
        log: deps.log,
        fetch: deps.fetch,
        stateDir: deps.env.stateDir,
        payloads: () => config.current().payloads,
        secret: deps.secrets.get,
        execPrefix: [],
        boxId: deps.identity.boxId,
      });

    // Payload users first, so the protocol server can hand each socket to its payload (A2 `owner`).
    const jailOn = () => box().jail.enabled && box().jail.egress !== "off";
    const agentUids = new Map<string, number>();
    const passwd = async () => (await deps.files.readText("/etc/passwd")) ?? "";
    if (!opts.supervisor) {
      for (const d of config.current().payloads) {
        await ensureUser(deps.exec, d.user, signal.signal);
        if (jailOn()) agentUids.set(d.name, await ensureAgentUser({ exec: deps.exec, passwd }, d.name, signal.signal));
      }
    }
    const users = parsePasswd(await passwd());
    const owner = (p: string) => {
      const u = users.find((e) => e.name === defOf(p)?.user);
      return u ? { uid: u.uid, gid: u.gid } : null;
    };

    const store = await makeProtocolStore({
      files: deps.files,
      path: `${deps.env.stateDir}/protocol.json`,
      bootId: deps.identity.bootId,
      holdMaxSeconds: (p) => defOf(p)?.limits?.holdMaxSeconds ?? 28_800,
      onClamped: (_p, id, until) => publish("hold-clamped", { id, until: toInstant(until) }),
    });
    const coalesce = makeCoalescingPublisher({ publisher: deps.records, clock: deps.clock, rand: Math.random });
    const alerts = makeAlertForwarder({ notifier: deps.notifierFor(box().alerts.topicArn), now, ids: randomUUID });
    const timeline = makeBootTimeline({
      clock: deps.clock,
      records: deps.records,
      files: deps.files,
      bootAt: await bootTimeOf(deps.files, now()),
    });
    const bootedAt = (await timeline.steps())[0]?.startedAt ?? now();
    const readiness = (s: AbortSignal): Promise<JailReadiness> =>
      opts.jail?.(deps) ??
      jailReadiness(
        { exec: deps.exec, files: deps.files },
        {
          ...box().jail,
          egress: box().jail.egress === "allowlist" ? "allowlist" : "imds-only",
          tripwire: box().tripwire.enabled,
        },
        s,
      );
    const egressNow = (): JailReadiness["egress"] =>
      box().jail.enabled ? (box().jail.egress === "allowlist" ? "allowlist" : "imds-only") : "off";
    let jail = await readiness(signal.signal);
    // This snapshot is taken before setupHost writes the profile, the nft table and the tripwire units. Refresh in
    // order, so a slow check cannot overwrite a newer one.
    let refreshing: Promise<void> = Promise.resolve();
    const refreshJail = (s: AbortSignal): Promise<void> => {
      refreshing = refreshing
        .catch(() => {})
        .then(async () => {
          try {
            jail = await readiness(s);
          } catch (e) {
            // A failed check must not leave the last good fact in place: report not-ready with the error.
            jail = { ready: false, egress: egressNow(), missing: [messageOf(e)] };
            throw e;
          }
        });
      return refreshing;
    };

    let verdict: IdleVerdict | null = null;
    let disk: DiskReading | null = null;
    let net: NetState | null = null;
    let netDownSince: number | null = null;
    let lastHealth: ReadonlyArray<HealthResult> = [];

    const parkNow = async (reason: ParkReason, detail: string): Promise<void> => {
      if (!canPark(phase.get()) && !(reason === "reclaim" && phase.get().phase === "reclaim-notice")) return;
      publish("sleeping", { reason, at: toInstant(now()) });
      await coalesce.flush(deps.clock.timeout(10_000)).catch((e: unknown) => log.log("warn", "flush", { error: e }));
      await park(
        {
          clock: deps.clock,
          records: deps.records,
          errors: deps.errors,
          holds: store,
          payloads: supervisor,
          selfStop: deps.selfStop,
          target: deps.machine,
          phase,
          log: deps.log,
          strikes: () => health.strikes(),
        },
        reason,
        detail,
      );
    };

    const health = healthLoop({
      clock: deps.clock,
      log: deps.log,
      payloads: {
        ...supervisor,
        checkHealth: async (s) => (lastHealth = await supervisor.checkHealth(s)),
      },
      everyMs: box().health.checkEverySeconds * 1000,
      config: () => box().health,
      phase,
      netUp: () => (net?.strikes ?? 0) === 0,
      missedLoops: () => config.current().payloads.flatMap((d) => store.beatsOf(d.name, now()).missedLoops),
      park: parkNow,
      onServing: async (payload) => {
        await deps.records.put("rec/serving", { payload });
        await deps.records.delete("rec/last-error");
        await deps.records.delete("rec/last-words");
        await deps.files.writeAtomic(`${RUN_DIR}/serving`, `${toInstant(now())}\n`).catch(() => {});
        await timeline.step("serving", async () => {});
        await timeline.publish();
      },
    });

    const makeServer = opts.server ?? makeProtocolServer;
    const srv = makeServer({
      store,
      log: deps.log,
      now,
      clock: deps.clock,
      bootId: deps.identity.bootId,
      boxId: deps.identity.boxId,
      agentVersion: opts.version ?? "dev",
      payloads: () => config.current().payloads.map((p) => p.name),
      owner,
      holdMaxSeconds: (p) => defOf(p)?.limits?.holdMaxSeconds ?? 28_800,
      status: (p) =>
        buildStatus(
          {
            identity: deps.identity,
            bootedAt,
            phase: phase.get(),
            verdict,
            disk,
            jail,
            memoryBytes: totalmem(),
            cpus: availableParallelism(),
            awakeSecondsCap: capSeconds(box().caps.awakeHoursPerDay),
          },
          store,
          p,
          now(),
        ),
      presenceSources: [
        ...(box().presenceSources.ssh ? [sshPresenceSource({ read })] : []),
        tcpPresenceSource({ read, ports: () => box().presenceSources.tcpPorts }),
      ],
      sleep: async (force) => {
        if (!canPark(phase.get())) return { accepted: false, blockers: ["parking"] };
        const blockers =
          verdict?.kind === "awake" && !force ? verdict.because.filter((b) => b !== "recent-activity") : [];
        if (blockers.length > 0) return { accepted: false, blockers };
        void parkNow("user", force ? "sleep requested (forced)" : "sleep requested").catch((e: unknown) =>
          log.log("error", "park failed", { error: e }),
        );
        return { accepted: true, blockers: [] };
      },
      attention: (p, a) =>
        alerts.forward({ source: `payload:${p}`, severity: a.severity, title: a.title, body: a.body ?? "" }),
      accepting: () => canPark(phase.get()),
      onChange: (what) => {
        if (what !== "wakes") return;
        void store.wakeRequests().then((wakes) => coalesce.offer("rec/wakes", { atPark: false, wakes: [...wakes] }));
      },
    });
    server = srv;
    await srv.start();

    let applied: string | null = null;
    const payloadsLoop: Loop = {
      name: "payloads",
      everyMs: PAYLOADS_EVERY_MS,
      immediate: true,
      tick: async (s) => {
        const key = JSON.stringify(config.current().payloads);
        if (key === applied || phase.get().phase === "sleeping") return;
        try {
          if (applied === null) await timeline.step("payload-start", () => supervisor.startAll(s));
          else await supervisor.startAll(s);
          applied = key;
        } catch (e) {
          await deps.records.lastError("payloads", messageOf(e)).catch(() => {});
          throw e instanceof RunnerError ? e : new RunnerError("internal", true, messageOf(e), { cause: e });
        }
      },
    };

    const sampler = makeActivitySampler({
      files: deps.files,
      payloads: () => config.current().payloads,
      healthy: (name) => health.healthy(name),
    });
    const idle = idleLoop({
      clock: deps.clock,
      holds: store,
      idleMs: () => box().idle.idleMinutes * MINUTE,
      viewingGraceMs: () => box().idle.viewingGraceMinutes * MINUTE,
      servingSince: () => health.servingSince(),
      lastActivityAt: () => sampler.sample(now()),
      phase: phase.get,
      onVerdict: (v) => {
        verdict = v;
        const p = phase.get();
        if (v.kind === "idle" && p.phase === "serving")
          phase.set({ phase: "idle-pending", since: now(), sleepAt: v.sleepAt });
        if (v.kind === "awake" && p.phase === "idle-pending") phase.set({ phase: "serving", since: now() });
      },
      park: parkNow,
    });

    const stats = opts.hostStats ?? makeLinuxHostStats({ fs: fsp });
    const reclaim = makeReclaim({ publish, park: parkNow, stopGraceSeconds: DEFAULT_STOP_GRACE_SECONDS });
    const loops: Loop[] = [
      payloadsLoop,
      health,
      idle,
      spotLoop({
        notices:
          opts.spotNotices ?? makeImdsSpotNotices({ fetch: deps.fetch, base: deps.env.imdsUrl, clock: deps.clock }),
        now,
        onNotice: async (notice) => {
          if (phase.get().phase !== "reclaim-notice" && canPark(phase.get())) {
            phase.set({ phase: "reclaim-notice", since: now(), terminationAt: notice.at });
          }
          await reclaim(notice);
        },
      }),
      diskLoop({
        stats,
        paths: ["/data", "/"],
        thresholds: box().disk,
        onChange: (r) => {
          if (r.path === "/data" || disk === null) disk = r;
          publish("disk", { level: r.level, freePct: r.freePct });
        },
      }),
      netLoop({
        stats,
        hosts: PROBE_HOSTS,
        now,
        timeout: deps.clock.timeout,
        onState: (s) => {
          if (s.strikes > 0 && netDownSince === null) netDownSince = now();
          if (s.strikes === 0) netDownSince = null;
          net = s;
        },
      }),
      logShipLoop({
        transport: deps.logs,
        group: box().logs.group,
        stream: deps.identity.instanceId,
        read: opts.journal ?? makeJournalReader({ exec: deps.exec }),
        now,
        budgetBytes: box().logs.dailyBudgetMiB * 2 ** 20,
        onBudget: () => {
          void alerts.forward({ source: "runner:logs", severity: "notify", title: "Box log budget reached", body: "" });
        },
      }),
      { name: "alerts", everyMs: MINUTE, tick: async (s) => void (await alerts.retry(s)) },
      {
        name: "liveness",
        everyMs: LIVENESS_OFFER_MS,
        immediate: true,
        tick: async () => {
          const t = now();
          const presence = await store.presence(t);
          const interactive = presence.filter((p) => p.kind === "interactive").map((p) => p.until);
          coalesce.offer(
            "rec/liveness",
            buildLiveness(
              {
                version: opts.version ?? "dev",
                strikes: health.strikes(),
                payloads: config.current().payloads,
                health: lastHealth,
                served: health.servingSince() !== null,
                interactiveUntil: interactive.length > 0 ? Math.max(...interactive) : null,
                lastInteractiveAt: await store.lastInteractiveAt(),
                verdict,
                net,
                netDownSince,
                disk,
                undelivered: alerts.undelivered(),
              },
              store,
              t,
            ),
          );
        },
      },
    ];
    loops.push(
      ...(await jailLoops({
        deps,
        box,
        jailOn: jailOn(),
        agentUids,
        alerts,
        log,
        payloadUsers: config.current().payloads.map((d) => d.user),
        signal: signal.signal,
        onEgressApplied: () =>
          void refreshJail(signal.signal).catch((e: unknown) => log.log("warn", "jail readiness", { error: e })),
      })),
    );
    await refreshJail(signal.signal).catch((e: unknown) => log.log("warn", "jail readiness", { error: e }));
    loops.push({
      name: "jail-ready",
      everyMs: JAIL_READY_EVERY_MS,
      immediate: true,
      tick: (s) => refreshJail(s),
    });

    return {
      loops,
      stop: async () => {
        signal.abort();
        await server?.stop();
      },
    };
  };
}
