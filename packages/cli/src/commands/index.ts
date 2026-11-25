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
import { secretsDelete, secretsList, secretsSet } from "./secrets.ts";
import { tokenRotate, tokenShow } from "./token.ts";
import { phoneList, phonePair, phoneRevoke } from "./phone.ts";
import { alertsPath, alertsTest } from "./alerts.ts";
import { snapshotsCreate, snapshotsDelete, snapshotsList } from "./snapshots.ts";
import { restore } from "./restore.ts";
import { destroy } from "./destroy.ts";
import { volumesList, volumesRetire } from "./volumes.ts";
import { moveAz } from "./move-az.ts";
import { rebuild } from "./rebuild.ts";
import { unfreeze } from "./unfreeze.ts";
import { drillCommand } from "./drill.ts";
import { BOX_COMMANDS } from "./box/index.ts";

export const COMMANDS: ReadonlyArray<Command> = [
  bootstrap,
  setup,
  deploy,
  status,
  wake,
  park,
  upgrade,
  doctor,
  secretsSet,
  secretsList,
  secretsDelete,
  tokenShow,
  tokenRotate,
  phonePair,
  phoneList,
  phoneRevoke,
  alertsTest,
  alertsPath,
  snapshotsList,
  snapshotsCreate,
  snapshotsDelete,
  restore,
  volumesList,
  volumesRetire,
  moveAz,
  rebuild,
  unfreeze,
  destroy,
  drillCommand(() => COMMANDS),
  ...BOX_COMMANDS,
];
