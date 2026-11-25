// Token auth for the control API (part 5 §5.3, part 9 §9.2.6). CloudFront OAC replaces `Authorization` with its own
// signature, so the token travels in `x-dozebox-token` (plus the alias headers the stack lists in
// DOZEBOX_CONTROL.http.tokenHeaders during a migration). The comparison hashes both sides first, so neither the
// length nor a prefix of the stored token leaks through timing. The stored token is cached 60 s; "no token stored" is
// never cached, so the first call after setup writes it does not wait out the cache.
import { createHash, timingSafeEqual } from "node:crypto";
import type { WakeTokenSource } from "../ports/secrets.ts";
import type { Request } from "./event.ts";

export const TOKEN_HEADER = "x-dozebox-token";
export const TOKEN_CACHE_MS = 60_000;

const sha256 = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

/** Constant-time for any lengths: equal digests and both sides non-empty. */
export function tokenMatches(presented: string, expected: string): boolean {
  const equal = timingSafeEqual(sha256(presented), sha256(expected));
  return equal && presented.length > 0 && expected.length > 0;
}

export type AuthOutcome = "ok" | "missing" | "wrong" | "not-configured";

export type TokenCheck = {
  readonly check: (req: Request) => Promise<AuthOutcome>;
};

export type TokenCheckDeps = {
  readonly source: WakeTokenSource;
  readonly now: () => number;
  /** Header names in order; the first one present is used. `x-dozebox-token` is always first. */
  readonly headers: ReadonlyArray<string>;
};

/** The header names a stack accepts: the primary one, then its aliases, without duplicates. */
export function tokenHeaders(aliases: ReadonlyArray<string> = []): ReadonlyArray<string> {
  return [...new Set([TOKEN_HEADER, ...aliases.map((h) => h.toLowerCase())])];
}

export function makeTokenCheck(deps: TokenCheckDeps): TokenCheck {
  let cache: { readonly value: string; readonly at: number } | null = null;

  async function expected(): Promise<string | null> {
    const now = deps.now();
    if (cache !== null && now - cache.at < TOKEN_CACHE_MS) return cache.value;
    const value = await deps.source.read();
    cache = value === null ? null : { value, at: now };
    return value;
  }

  return {
    check: async (req) => {
      const presented = deps.headers.map((h) => req.header(h)?.trim() ?? "").find((v) => v !== "") ?? "";
      if (presented === "") return "missing";
      const stored = await expected();
      if (stored === null) return "not-configured";
      return tokenMatches(presented, stored) ? "ok" : "wrong";
    },
  };
}
