// The `summary` block of ControlStatus (part 5 §5.3): one line a person reads first. Words come from the copy, with the
// config's `brand.name` put in for `{brand}`, so the runner names no payload itself. Caps and the freeze come first,
// then the box state (the held-cap rows are the legacy `capsSummaryRow`).

export type ControlState = "parked" | "launching" | "running" | "waiting-capacity" | "replacing" | "stopped-error";
export type SummaryLevel = "ok" | "info" | "warn" | "bad";
export type Summary = {
  readonly level: SummaryLevel;
  readonly headline: string;
  readonly detail: string;
  readonly next: string;
  readonly actions: ReadonlyArray<string>;
};

export type HeldCap = {
  readonly rule: "frozen" | "native" | "awake-24h" | "per-wake" | "on-demand-hours";
  readonly blocksWake: boolean;
  readonly awakeMinutes?: number;
  readonly wakesAt?: string | null;
  readonly alarm?: string | null;
  readonly frozenBy?: string | null;
};

export type SummaryCopy = Readonly<Record<SummaryKey, string>>;
export type SummaryKey =
  | "parked"
  | "launching"
  | "running"
  | "working"
  | "waitingCapacity"
  | "replacing"
  | "stoppedError"
  | "frozen"
  | "frozenNext"
  | "native"
  | "capPaused"
  | "capWakesAt"
  | "capWakesLater"
  | "busy"
  | "wakeAgain";

/** Default words. A stack overrides any key through its copy; `{brand}`, `{n}`, `{hours}`, `{at}`, `{what}` are filled in. */
export const DEFAULT_COPY: SummaryCopy = {
  parked: "{brand} is asleep",
  launching: "{brand} is waking",
  running: "{brand} is awake",
  working: "Working",
  waitingCapacity: "Waiting for cloud capacity",
  replacing: "Moving {brand} to a new machine",
  stoppedError: "{brand} stopped with an error",
  frozen: "Frozen: {what} reached its limit.",
  frozenNext: "Find out why, then run unfreeze.",
  native: "Frozen by AWS: {what}.",
  capPaused: "Paused: awake limit ({hours} h in 24 h).",
  capWakesAt: "Wakes again at {at}.",
  capWakesLater: "Wakes again when the cap clears.",
  busy: "{n} payload busy.",
  wakeAgain: "Wake it to try again.",
};

export type SummaryInput = {
  readonly now: number;
  readonly state: ControlState;
  readonly brand: { readonly name: string };
  readonly copy?: Partial<SummaryCopy>;
  /** The held cap record, or null. */
  readonly cap: HeldCap | null;
  readonly lastError?: { readonly message: string } | null;
  /** Payloads keeping the box awake (holds, presence), from rec/liveness. */
  readonly busyPayloads?: number;
};

const hours = (minutes: number): string => `${Math.round((minutes / 60) * 10) / 10}`.replace(/\.0$/, "");

export function composeSummary(i: SummaryInput): Summary {
  const copy = { ...DEFAULT_COPY, ...i.copy };
  const say = (key: SummaryKey, vars: Readonly<Record<string, string | number>> = {}): string =>
    copy[key].replace(/\{(\w+)\}/g, (all, name: string) =>
      name === "brand" ? i.brand.name : name in vars ? String(vars[name]) : all,
    );

  const cap = i.cap;
  if (cap !== null && cap.blocksWake) {
    if (cap.rule === "frozen")
      return {
        level: "bad",
        headline: say("frozen", { what: cap.frozenBy ?? "a budget" }),
        detail: "",
        next: say("frozenNext"),
        actions: ["unfreeze"],
      };
    const wakesAt = cap.wakesAt && (Date.parse(cap.wakesAt) || 0) > i.now ? cap.wakesAt : null;
    const next = wakesAt === null ? say("capWakesLater") : say("capWakesAt", { at: wakesAt });
    if (cap.rule === "native")
      return {
        level: "bad",
        headline: say("native", { what: cap.alarm ?? "a kill-switch alarm" }),
        detail: "",
        next,
        actions: [],
      };
    return {
      level: "warn",
      headline: say("capPaused", { hours: hours(cap.awakeMinutes ?? 0) }),
      detail: "",
      next,
      actions: cap.rule === "awake-24h" ? ["keep-awake-past-limit"] : [],
    };
  }
  switch (i.state) {
    case "parked":
      return { level: "info", headline: say("parked"), detail: "", next: "", actions: ["wake"] };
    case "launching":
      return { level: "info", headline: say("launching"), detail: "", next: "", actions: ["park"] };
    case "replacing":
      return { level: "info", headline: say("replacing"), detail: "", next: "", actions: ["park"] };
    case "waiting-capacity":
      return { level: "warn", headline: say("waitingCapacity"), detail: "", next: "", actions: ["park"] };
    case "stopped-error":
      return {
        level: "bad",
        headline: say("stoppedError"),
        detail: i.lastError?.message ?? "",
        next: say("wakeAgain"),
        actions: ["wake"],
      };
    case "running": {
      const n = i.busyPayloads ?? 0;
      return n > 0
        ? { level: "ok", headline: say("working"), detail: say("busy", { n }), next: "", actions: ["park"] }
        : { level: "ok", headline: say("running"), detail: "", next: "", actions: ["park"] };
    }
  }
}
