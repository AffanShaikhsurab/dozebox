// D1 (smoke), D2 (spot, fallback), D3 (kill, front-door, restore): the drills `dozebox drill <name>` runs.
import { fallbackDrill } from "./fallback.ts";
import { frontDoorDrill } from "./front-door.ts";
import { killDrill } from "./kill.ts";
import { restoreDrill } from "./restore.ts";
import { smokeDrill } from "./smoke.ts";
import { spotDrill } from "./spot.ts";
import type { Drill } from "./types.ts";

export { fallbackDrill, frontDoorDrill, killDrill, restoreDrill, smokeDrill, spotDrill };

export const DRILLS: ReadonlyArray<Drill> = [
  smokeDrill,
  spotDrill,
  fallbackDrill,
  killDrill,
  frontDoorDrill,
  restoreDrill,
];
