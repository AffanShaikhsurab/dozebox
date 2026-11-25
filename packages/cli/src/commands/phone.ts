import { stubCommand } from "../command.ts";

export const phone = stubCommand("L2", {
  name: "phone",
  summary: "Pair, list or revoke phones for Web Push.",
  mode: "operator",
  mutates: true,
});
