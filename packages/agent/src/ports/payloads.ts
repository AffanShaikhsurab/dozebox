// The payload units, as the idle, watchdog and park code (A5) and the jail (A8) see them. A3's supervisor
// implements it on systemd (`dozebox-payload@<name>.service`).

export type UnitActiveState = "active" | "activating" | "deactivating" | "inactive" | "failed" | "reloading";

export type PayloadUnitState = {
  readonly name: string;
  readonly active: UnitActiveState;
  /** Epoch ms the unit last entered `active`, or null. */
  readonly activeSince: number | null;
  readonly restarts: number;
};

export type HealthResult = { readonly name: string; readonly ok: boolean; readonly detail: string };

export interface PayloadSupervisor {
  /** Render units, run install hooks whose hash changed, write credentials, start every payload. */
  readonly startAll: (signal: AbortSignal) => Promise<void>;
  /** Stop every payload; resolves when all are inactive or `signal` fires (then kills). */
  readonly stopAll: (signal: AbortSignal) => Promise<void>;
  readonly restart: (name: string, signal: AbortSignal) => Promise<void>;
  readonly states: () => Promise<ReadonlyArray<PayloadUnitState>>;
  /** Run every definition's health check (http, command, systemd) once. */
  readonly checkHealth: (signal: AbortSignal) => Promise<ReadonlyArray<HealthResult>>;
}
