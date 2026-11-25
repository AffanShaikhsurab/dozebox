// D3: `dozebox drill front-door`. Turns the front door on for the stack (`front-door.auto.tfvars.json` with
// front_door = true, then `dozebox deploy`), checks `/v1/status` and `/v1/wake` through CloudFront with the wake token,
// a wrong token answering 401, and the WAF web ACL on the distribution; teardown parks and turns it off again
// (Terraform disables, then deletes the distribution). CloudFront deploys take 5 to 15 minutes each way, so this
// drill is slow; run it once per phase.
import { MINUTE, SECOND } from "@dozebox/core/time";
import { DozeboxCliError } from "../command.ts";
import { aws, cliOk, obj, str, waitUntil } from "./box.ts";
import { attemptAll, parkAndWait, teardownSignal } from "./parked.ts";
import type { Drill, DrillContext } from "./types.ts";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const varsFile = (ctx: DrillContext): string => `${ctx.stackDir.replace(/[\\/]+$/, "")}/front-door.auto.tfvars.json`;

async function setFrontDoor(ctx: DrillContext, on: boolean, signal: AbortSignal): Promise<void> {
  await ctx.deps.fs.writeText(varsFile(ctx), `${JSON.stringify({ front_door: on })}\n`);
  await cliOk(ctx, ["deploy"], signal);
}

async function domain(ctx: DrillContext): Promise<string> {
  const d = (await ctx.stack()).frontDoorDomain;
  if (d === null) throw new DozeboxCliError("problem", "the stack has no front_door_domain_name after the deploy");
  return d;
}

async function token(ctx: DrillContext): Promise<string> {
  const t = await ctx.deps.aws.getParameter((await ctx.stack()).wakeTokenParameter);
  if (t === null) throw new DozeboxCliError("not-set-up", "no wake token stored");
  return t;
}

export function makeFrontDoorDrill(fetchFn: Fetch): Drill {
  const call = async (ctx: DrillContext, path: string, init: RequestInit, signal: AbortSignal): Promise<Response> =>
    fetchFn(`https://${await domain(ctx)}${path}`, { ...init, signal });
  return {
    name: "front-door",
    // WAF web ACL (USD 5 a month) and one rule prorated over about an hour, CloudFront requests, a short wake.
    estimateUsd: async () => 0.05,
    steps: [
      {
        id: "enable",
        deadlineMs: 30 * MINUTE,
        run: async (ctx, signal) => {
          await setFrontDoor(ctx, true, signal);
          ctx.facts.set("frontDoor", await domain(ctx));
        },
      },
      {
        id: "status",
        deadlineMs: 15 * MINUTE,
        run: async (ctx, signal) => {
          const t = await token(ctx);
          const body = await waitUntil(ctx, signal, 15 * SECOND, async () => {
            const res = await call(ctx, "/v1/status", { headers: { "x-dozebox-token": t } }, signal).catch(() => null);
            return res?.status === 200 ? obj(await res.json()) : null;
          });
          if (body["v"] !== 1)
            throw new DozeboxCliError("problem", `status through CloudFront: ${JSON.stringify(body)}`);
        },
      },
      {
        id: "wrong-token",
        deadlineMs: 2 * MINUTE,
        run: async (ctx, signal) => {
          const res = await call(ctx, "/v1/status", { headers: { "x-dozebox-token": "wrong" } }, signal);
          if (res.status !== 401)
            throw new DozeboxCliError("problem", `a wrong token answered ${res.status}, want 401`);
        },
      },
      {
        id: "wake",
        deadlineMs: 2 * MINUTE,
        run: async (ctx, signal) => {
          const res = await call(
            ctx,
            "/v1/wake",
            { method: "POST", headers: { "x-dozebox-token": await token(ctx), "Idempotency-Key": ctx.runId } },
            signal,
          );
          const body = obj(await res.json().catch(() => ({})));
          if (res.status >= 300 || body["decision"] !== "accept") {
            throw new DozeboxCliError("problem", `wake through CloudFront: ${res.status} ${JSON.stringify(body)}`);
          }
        },
      },
      {
        id: "waf",
        deadlineMs: 2 * MINUTE,
        run: async (ctx, signal) => {
          const d = await domain(ctx);
          const list = await aws(ctx, ["cloudfront", "list-distributions"], signal);
          const items = (obj(list["DistributionList"])["Items"] ?? []) as ReadonlyArray<unknown>;
          const dist = items.map(obj).find((i) => i["DomainName"] === d);
          const acl = str(dist?.["WebACLId"]);
          if (acl === null) throw new DozeboxCliError("problem", `distribution ${d} has no WAF web ACL`);
          ctx.facts.set("webAcl", acl);
        },
      },
    ],
    teardown: async (ctx) => {
      const signal = ctx.deps.clock.timeout(40 * MINUTE);
      await attemptAll(ctx, [
        ["park", () => parkAndWait(ctx, teardownSignal(ctx))],
        ["front door off", () => setFrontDoor(ctx, false, signal)],
      ]);
    },
  };
}

export const frontDoorDrill: Drill = makeFrontDoorDrill((url, init) => fetch(url, init));
