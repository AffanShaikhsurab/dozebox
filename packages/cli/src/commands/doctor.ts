import { stubCommand } from "../command.ts";

export const doctor = stubCommand("L1", {
  name: "doctor",
  summary: "Check tools, credentials, the stack and the alert path.",
  mode: "operator",
  mutates: false,
});
