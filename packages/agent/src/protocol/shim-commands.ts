// The box shim's command list. `/opt/dozebox/current/bin/dozebox` is this shim, not the full CLI, so the generated
// CLI reference takes its box section from here. `parseShim` is the behaviour; this is the documentation.
export type ShimCommand = {
  readonly name: string;
  readonly summary: string;
  /** Flag, meaning. */
  readonly options: ReadonlyArray<readonly [string, string]>;
};

export const SHIM_COMMANDS: ReadonlyArray<ShimCommand> = [
  {
    name: "hold",
    summary: "Keep the box awake until a time, or release the hold.",
    options: [
      ["--payload <name>", "The payload the hold belongs to. Required."],
      ["--reason <text>", "Why the box stays awake. Required unless --release."],
      ["--for <30m|2h|90s>", "Hold for a duration from now."],
      ["--until <instant>", "Hold until an instant."],
      ["--wait", "A wait hold; the default is a work hold."],
      ["--max <seconds>", "Cap the hold at this many seconds."],
      ["--release", "Release the hold instead of taking one."],
    ],
  },
  {
    name: "wake-request",
    summary: "Ask the box to wake at a time, or cancel that request.",
    options: [
      ["--payload <name>", "The payload the request belongs to. Required."],
      ["--reason <text>", "Why the box should wake. Required unless --cancel."],
      ["--at <instant>", "When to wake. Required unless --cancel."],
      ["--expires <instant>", "When the request stops being valid."],
      ["--cancel", "Cancel the request instead of making one."],
    ],
  },
];
