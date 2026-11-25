// C5: the hook route body: verify, read `rec/wakes` (falling back to `github-waits`), match, dedupe, write the wake
// intent with origin `event`. Answers 202 after the match; the reconcile tick does the slow work.
import type { HookRequest, BoxWakes, WakeSource } from "../ports/wakeSource.ts";

export type HookAnswer =
  | { readonly status: 202; readonly body: { readonly wake: boolean; readonly why: string } }
  | { readonly status: 401 | 404 | 413; readonly body: { readonly error: { readonly code: string } } };

export type HookDeps = {
  readonly sources: ReadonlyArray<WakeSource>;
  readonly wakes: () => Promise<BoxWakes>;
  /** Idempotency on `dedupeKey`: true the first time a key is seen. */
  readonly firstDelivery: (dedupeKey: string) => Promise<boolean>;
  /** Record desired = awake with origin `event` (decideWake decides; the route never calls Compute). */
  readonly requestWake: (why: string, wakeIds: ReadonlyArray<string>) => Promise<void>;
  readonly now: () => number;
};

const BODY_LIMIT_BYTES = 64 * 1024;

const fail = (status: 401 | 404 | 413, code: string): HookAnswer => ({ status, body: { error: { code } } });

function routeMatches(source: WakeSource, req: HookRequest): boolean {
  const { method, path } = source.route;
  if (req.method !== method) return false;
  return path.endsWith("/") ? req.path.startsWith(path) : req.path === path;
}

export async function handleHook(deps: HookDeps, req: HookRequest): Promise<HookAnswer> {
  const source = deps.sources.find((s) => routeMatches(s, req));
  if (!source) return fail(404, "not_found");
  if (req.rawBody.length > BODY_LIMIT_BYTES) return fail(413, "too_large");
  if (!(await source.verify(req, deps.now()))) return fail(401, "unauthorized");
  const found = source.match(req, await deps.wakes(), deps.now());
  if (!found.wake) return { status: 202, body: { wake: false, why: found.why } };
  if (!(await deps.firstDelivery(found.dedupeKey))) return { status: 202, body: { wake: false, why: "duplicate" } };
  await deps.requestWake(found.why, found.wakeIds);
  return { status: 202, body: { wake: true, why: found.why } };
}
