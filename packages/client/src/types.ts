import type {
  AttentionAccepted,
  AttentionInput,
  Beat,
  Hello,
  Hold,
  HoldInput,
  Status,
  Wake,
  WakeInput,
} from "@dozebox/protocol/v1";

export type DozeboxClientOptions = {
  /** Default: process.env.DOZEBOX_SOCKET. */
  readonly socketPath?: string;
  /** Default 2000. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

export type DozeboxEvent =
  | { readonly type: "phase"; readonly phase: Status["box"]["phase"]; readonly since: string }
  | { readonly type: "reclaim-notice"; readonly terminationAt: string; readonly stopGraceSeconds: number }
  | { readonly type: "sleeping"; readonly reason: string; readonly at: string }
  | { readonly type: "disk"; readonly level: "ok" | "low" | "critical"; readonly freePct: number }
  | { readonly type: "hold-clamped"; readonly id: string; readonly until: string }
  | { readonly type: "cap-reached"; readonly cap: string; readonly resetAt: string }
  | { readonly type: "unknown"; readonly name: string; readonly data: unknown };

export interface DozeboxClient {
  readonly hello: () => Promise<Hello>;
  readonly status: () => Promise<Status>;
  readonly hold: (id: string, input: HoldInput) => Promise<Hold>;
  readonly release: (id: string) => Promise<void>;
  /** Renews every `renewEverySeconds` to now + `forSeconds` until the returned stop(). */
  readonly keepHold: (
    id: string,
    opts: {
      readonly reason: string;
      readonly forSeconds: number;
      readonly renewEverySeconds?: number;
      readonly kind?: "work" | "wait";
    },
  ) => { readonly stop: () => Promise<void> };
  readonly beat: (beats: ReadonlyArray<Beat>) => Promise<void>;
  readonly wake: (id: string, input: WakeInput) => Promise<Wake>;
  readonly cancelWake: (id: string) => Promise<void>;
  readonly presence: (id: string, kind: "interactive" | "viewing", forSeconds: number) => Promise<void>;
  readonly attention: (input: AttentionInput) => Promise<AttentionAccepted>;
  /** 409 SleepRefused maps to `{ accepted: false, blockers }`. */
  readonly sleep: (opts?: {
    readonly force?: boolean;
  }) => Promise<{ readonly accepted: boolean; readonly blockers: ReadonlyArray<string> }>;
  /** SSE with reconnect and `Last-Event-ID`. */
  readonly events: (onEvent: (e: DozeboxEvent) => void) => { readonly close: () => void };
}
