import { stubCommand } from "../command.ts";

export const upgrade = stubCommand("L1", {
  name: "upgrade",
  summary: "Set the agent version and apply.",
  mode: "operator",
  mutates: true,
});
