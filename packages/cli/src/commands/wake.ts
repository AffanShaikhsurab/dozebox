import { stubCommand } from "../command.ts";

export const wake = stubCommand("L1", {
  name: "wake",
  summary: "Wake the box and optionally wait until it serves.",
  mode: "both",
  mutates: true,
});
