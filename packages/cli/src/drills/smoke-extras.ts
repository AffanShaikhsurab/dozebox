// The smoke drill's optional steps: 12 (control upgrade and rollback) and the phase 6 extras (`--extra`).
import { DozeboxCliError } from "../command.ts";
import { aws, cliOk, record, runningInstance, shell, str, waitUntil } from "./box.ts";
import type { DrillContext, DrillStep } from "./types.ts";

const MIN = 60_000;

async function aliasVersion(ctx: DrillContext, fn: string, signal: AbortSignal): Promise<string> {
  const a = await aws(ctx, ["lambda", "get-alias", "--function-name", fn, "--name", "live"], signal);
  const v = str(a["FunctionVersion"]);
  if (v === null) throw new DozeboxCliError("aws", `alias live of ${fn} has no version`);
  return v;
}

async function moveAlias(ctx: DrillContext, fn: string, version: string, signal: AbortSignal): Promise<void> {
  await aws(
    ctx,
    ["lambda", "update-alias", "--function-name", fn, "--name", "live", "--function-version", version],
    signal,
  );
  await cliOk(ctx, ["status"], signal);
}

/**
 * Step 12. The CLI has no `upgrade --control-only` yet, so the drill does what it would: publish the deployed code
 * as a new version, move alias `live` to it, check `/v1/status`, move it back, check again.
 */
const upgradeStep: DrillStep = {
  id: "upgrade",
  deadlineMs: 3 * MIN,
  run: async (ctx, signal) => {
    const fn = (await ctx.stack()).controlFunctionName;
    const before = await aliasVersion(ctx, fn, signal);
    const published = str((await aws(ctx, ["lambda", "publish-version", "--function-name", fn], signal))["Version"]);
    if (published === null) throw new DozeboxCliError("aws", "publish-version answered no version");
    ctx.facts.set("controlVersions", { before, candidate: published });
    await moveAlias(ctx, fn, published, signal);
    if ((await aliasVersion(ctx, fn, signal)) !== published) throw new DozeboxCliError("problem", "alias did not move");
    await moveAlias(ctx, fn, before, signal);
    if ((await aliasVersion(ctx, fn, signal)) !== before) throw new DozeboxCliError("problem", "alias did not return");
  },
};

const has = (extra: string) => (o: { readonly extras: ReadonlyArray<string> }) => o.extras.includes(extra);

/** Phase 6: the jail escape suite on the real box (the agent's systemd tests, shipped in the release). */
const jailStep: DrillStep = {
  id: "jail",
  deadlineMs: 10 * MIN,
  when: has("jail"),
  run: async (ctx, signal) => {
    const i = await runningInstance(ctx, signal);
    const out = await shell(ctx, i.id, "/opt/dozebox/current/bin/dozebox-jail-check", signal, { timeoutSeconds: 540 });
    ctx.facts.set("jail", out.stdout.trim().split("\n").slice(-5));
  },
};

/** Phase 6: use the decoy credential on the box and expect a page with the caller context. */
const tripwireStep: DrillStep = {
  id: "tripwire",
  deadlineMs: 12 * MIN,
  when: has("tripwire"),
  run: async (ctx, signal) => {
    const i = await runningInstance(ctx, signal);
    const since = ctx.deps.clock.now();
    await shell(
      ctx,
      i.id,
      "AWS_PROFILE=dozebox-decoy DOZEBOX_CONTEXT=drill aws sts get-caller-identity 2>&1 || true",
      signal,
      { check: false },
    );
    const err = await waitUntil(ctx, signal, 20_000, async () => {
      const r = await record(ctx, "last-error", signal);
      const at = Date.parse(str(r?.["at"]) ?? "");
      return r !== null && at >= since && /tripwire/i.test(JSON.stringify(r)) ? r : null;
    });
    ctx.facts.set("tripwire", err);
  },
};

/** Phase 6: upgrade to a deliberately broken release and expect `rec/release` rolled back within 5 minutes. */
const rollbackStep: DrillStep = {
  id: "agent-rollback",
  deadlineMs: 8 * MIN,
  when: has("agent-rollback"),
  run: async (ctx, signal) => {
    if (ctx.options.broken === null)
      throw new DozeboxCliError("usage", "--extra agent-rollback needs --broken <tarball>");
    const since = ctx.deps.clock.now();
    await cliOk(ctx, ["upgrade", "--agent", ctx.options.broken], signal);
    const rel = await waitUntil(ctx, signal, 15_000, async () => {
      const r = await record(ctx, "release", signal);
      return r !== null && Date.parse(str(r["at"]) ?? "") >= since && r["outcome"] === "rolled-back" ? r : null;
    });
    ctx.facts.set("release", rel);
  },
};

export const smokeExtras: ReadonlyArray<DrillStep> = [upgradeStep, jailStep, tripwireStep, rollbackStep];
