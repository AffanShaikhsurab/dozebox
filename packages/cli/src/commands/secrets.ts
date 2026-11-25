import { stubCommand } from "../command.ts";

export const secrets = stubCommand("L2", {
  name: "secrets",
  summary: "Set, list or delete shared secrets; values come from stdin only.",
  mode: "operator",
  mutates: true,
});
