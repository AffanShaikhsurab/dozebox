// D1: `dozebox drill <name>` runs one drill of the catalog against the stack and writes its JSON report.
import { stubCommand, type Command } from "../command.ts";

/** `commands` is the full command list (the drill runs other commands through the dispatcher). */
export function drillCommand(_commands: () => ReadonlyArray<Command>): Command {
  return stubCommand("D1", {
    name: "drill",
    summary: "Run a real-AWS drill: smoke, spot, fallback, kill, front-door, restore.",
    mode: "operator",
    mutates: true,
  });
}
