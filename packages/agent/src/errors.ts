// The agent's recent errors, newest last, for last words (`recentErrors`) and status. Bounded; never throws.

type RecentError = { readonly at: number; readonly source: string; readonly message: string };

export interface ErrorLog {
  readonly add: (source: string, error: unknown) => void;
  /** The last `n` errors, oldest first. */
  readonly recent: (n: number) => ReadonlyArray<RecentError>;
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return typeof error === "string" ? error : (JSON.stringify(error) ?? String(error));
}

export function makeErrorLog(now: () => number, keep = 50): ErrorLog {
  const items: RecentError[] = [];
  return {
    add: (source, error) => {
      items.push({ at: now(), source, message: messageOf(error).slice(0, 1000) });
      if (items.length > keep) items.splice(0, items.length - keep);
    },
    recent: (n) => items.slice(Math.max(0, items.length - n)),
  };
}
