// Every command, in help order. A lane adds its command here when it adds the file.
import type { Command } from "../command.ts";
import { deploy } from "./deploy.ts";
import { status } from "./status.ts";
import { wake } from "./wake.ts";
import { park } from "./park.ts";
import { upgrade } from "./upgrade.ts";
import { doctor } from "./doctor.ts";
import { bootstrap } from "./bootstrap.ts";
import { setup } from "./setup.ts";
import { secrets } from "./secrets.ts";
import { token } from "./token.ts";
import { phone } from "./phone.ts";
import { alerts } from "./alerts.ts";
import { snapshots } from "./snapshots.ts";
import { restore } from "./restore.ts";
import { destroy } from "./destroy.ts";
import { volumes } from "./volumes.ts";
import { moveAz } from "./move-az.ts";
import { rebuild } from "./rebuild.ts";
import { unfreeze } from "./unfreeze.ts";
import { drill } from "./drill.ts";

export const COMMANDS: ReadonlyArray<Command> = [
  deploy,
  status,
  wake,
  park,
  upgrade,
  doctor,
  bootstrap,
  setup,
  secrets,
  token,
  phone,
  alerts,
  snapshots,
  restore,
  destroy,
  volumes,
  moveAz,
  rebuild,
  unfreeze,
  drill,
];
