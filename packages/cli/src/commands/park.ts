import { stubCommand } from "../command.ts";

export const park = stubCommand("L1", {
  name: "park",
  summary: "Ask the control function to park the box.",
  mode: "operator",
  mutates: true,
});
