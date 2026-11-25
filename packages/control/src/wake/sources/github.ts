// C5: GitHub webhooks (HMAC SHA-256 in X-Hub-Signature-256, X-GitHub-Delivery as the dedupe key, answer in 10 s).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { WakeSource } from "../../ports/wakeSource.ts";

type GithubFilter = {
  readonly source?: string;
  readonly repository?: string;
  readonly events?: ReadonlyArray<string>;
  readonly number?: number;
  readonly actions?: ReadonlyArray<string>;
};

type GithubBody = {
  readonly action?: string;
  readonly number?: number;
  readonly issue?: { readonly number?: number };
  readonly repository?: { readonly full_name?: string };
  readonly pull_request?: { readonly number?: number };
  readonly check_suite?: { readonly pull_requests?: ReadonlyArray<{ readonly number?: number }> };
  readonly check_run?: { readonly pull_requests?: ReadonlyArray<{ readonly number?: number }> };
};

function parseBody(raw: Uint8Array): GithubBody | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw).toString("utf8"));
    return typeof value === "object" && value !== null ? (value as GithubBody) : null;
  } catch {
    return null;
  }
}

function numbersOf(body: GithubBody): Set<number> {
  const out = new Set<number>();
  const add = (n: number | undefined): void => {
    if (typeof n === "number") out.add(n);
  };
  add(body.number);
  add(body.issue?.number);
  add(body.pull_request?.number);
  for (const p of body.check_suite?.pull_requests ?? []) add(p.number);
  for (const p of body.check_run?.pull_requests ?? []) add(p.number);
  return out;
}

export function githubSource(getSecret: () => Promise<string | null>): WakeSource {
  return {
    id: "github",
    route: { method: "POST", path: "/v1/hooks/github" },
    verify: async (req) => {
      const secret = await getSecret();
      const sig = req.headers["x-hub-signature-256"];
      if (!secret || !sig?.startsWith("sha256=")) return false;
      const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(req.rawBody).digest("hex")}`);
      const got = Buffer.from(sig);
      return got.length === want.length && timingSafeEqual(got, want);
    },
    match: (req, wakes, now) => {
      const event = req.headers["x-github-event"] ?? "";
      const delivery = req.headers["x-github-delivery"] ?? "";
      const body = parseBody(req.rawBody);
      if (body === null) return { wake: false, why: "bad-json" };
      const repo = body.repository?.full_name?.toLowerCase();
      const numbers = numbersOf(body);
      const hits = wakes.filter((w) => {
        const on = w.on as GithubFilter | null | undefined;
        if (on?.source !== "github" || Date.parse(w.expiresAt) < now) return false;
        if (repo === undefined || on.repository?.toLowerCase() !== repo) return false;
        if (!on.events?.includes(event)) return false;
        if (on.number !== undefined && !numbers.has(on.number)) return false;
        if (on.actions !== undefined && !on.actions.includes(body.action ?? "")) return false;
        return true;
      });
      if (hits.length === 0) return { wake: false, why: "no-matching-wake" };
      return {
        wake: true,
        why: `github:${event}`,
        wakeIds: hits.map((w) => `${w.payload}/${w.id}`),
        dedupeKey: `github:${delivery}`,
      };
    },
  };
}
