import { stubCommand } from "../command.ts";

export const alerts = stubCommand("L2", {
  name: "alerts",
  summary: "Send a test alert or show the alert path verdict.",
  mode: "operator",
  mutates: true,
});
