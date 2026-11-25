// Notifications to the service manager (sd_notify): `READY=1`, `WATCHDOG=1`, `STOPPING=1`, `STATUS=...`.

export interface Systemd {
  /** Send one notification. A no-op when the agent does not run under systemd (no NOTIFY_SOCKET). */
  readonly notify: (state: string) => Promise<void>;
}
