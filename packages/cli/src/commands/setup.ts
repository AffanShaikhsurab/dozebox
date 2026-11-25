import { stubCommand } from "../command.ts";

export const setup = stubCommand("L2", {
  name: "setup",
  summary: "Re-runnable setup: apply, store the wake token, subscribe alerts, run doctor.",
  mode: "operator",
  mutates: true,
});
