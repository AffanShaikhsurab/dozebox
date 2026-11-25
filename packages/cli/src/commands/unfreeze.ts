import { stubCommand } from "../command.ts";

export const unfreeze = stubCommand("L4", {
  name: "unfreeze",
  summary: "Run the unfreeze runbook after a kill-switch freeze.",
  mode: "operator",
  mutates: true,
});
