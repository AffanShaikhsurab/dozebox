// Box-mode commands (run on the box over the agent socket), in the plan's table order.
import type { Command } from "../../command.ts";
import { boxAttention } from "./attention.ts";
import { boxBeat } from "./beat.ts";
import { boxHold } from "./hold.ts";
import { boxPresence } from "./presence.ts";
import { boxRun } from "./run.ts";
import { boxSleep } from "./sleep.ts";
import { boxStatus } from "./status.ts";
import { boxWake } from "./wake.ts";

export const BOX_COMMANDS: ReadonlyArray<Command> = [
  boxStatus,
  boxHold,
  boxBeat,
  boxWake,
  boxPresence,
  boxAttention,
  boxRun,
  boxSleep,
];
