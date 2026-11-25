import { stubCommand } from "../command.ts";

export const token = stubCommand("L2", {
  name: "token",
  summary: "Show the wake link or rotate the wake token.",
  mode: "operator",
  mutates: true,
});
