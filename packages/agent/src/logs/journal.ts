// journald -> log events: `journalctl -o json` after a cursor, parsed leniently (a bad line never stops shipping).
import { RunnerError } from "@dozebox/core/errors";
import type { Exec } from "../ports/exec.ts";
import type { LogEvent } from "../ports/logs.ts";

export type JournalRead = {
  readonly events: ReadonlyArray<LogEvent>;
  readonly cursor: string | null;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function messageOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    return Buffer.from(v as number[]).toString("utf8");
  }
  return null;
}

export function makeJournalReader(deps: {
  readonly exec: Exec;
  readonly units?: ReadonlyArray<string>;
}): (cursor: string | null, max: number) => Promise<JournalRead> {
  return async (cursor, max) => {
    const argv = [
      "journalctl",
      "-o",
      "json",
      "--no-pager",
      "-b",
      ...(cursor === null ? [] : [`--after-cursor=${cursor}`]),
      ...(deps.units ?? []).flatMap((u) => ["-u", u]),
    ];
    const res = await deps.exec.run(argv);
    if (res.code !== 0) {
      throw new RunnerError("internal", true, `journalctl exited ${res.code}: ${res.stderr.slice(0, 200)}`);
    }
    const events: LogEvent[] = [];
    let last = cursor;
    for (const line of res.stdout.split("\n")) {
      if (events.length >= max) break;
      if (line.trim() === "") continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObject(entry)) continue;
      const message = messageOf(entry["MESSAGE"]);
      const micros = Number(entry["__REALTIME_TIMESTAMP"]);
      if (message === null || !Number.isFinite(micros)) continue;
      events.push({ at: micros / 1000, message });
      const c = entry["__CURSOR"];
      if (typeof c === "string") last = c;
    }
    return { events, cursor: last };
  };
}
