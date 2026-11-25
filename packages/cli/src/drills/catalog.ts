// D1 (smoke), D2 (spot, fallback), D3 (kill, front-door, restore): the drills `dozebox drill <name>` runs.
import type { Drill } from "./types.ts";

function stubDrill(pkg: string, name: string): Drill {
  const no = (): never => {
    throw new Error(`not implemented: ${pkg} drill ${name}`);
  };
  return { name, estimateUsd: async () => no(), steps: [], teardown: async () => no() };
}

/** Wake, serve `examples/payloads/marker`, park, wake again, upgrade (skippable). */
export const smokeDrill: Drill = stubDrill("D1", "smoke");
/** FIS `aws:ec2:send-spot-instance-interruptions` with a hold live; stop condition on the cap alarm. */
export const spotDrill: Drill = stubDrill("D2", "spot");
/** A launch template version Spot cannot serve; a person's wake serves On-Demand; teardown restores the default. */
export const fallbackDrill: Drill = stubDrill("D2", "fallback");
/** Cap alarm threshold to 0 for 10 min: deny attached, instance stopped, group 0, page; then unfreeze. */
export const killDrill: Drill = stubDrill("D3", "kill");
/** `/v1/status` and `/v1/wake` through CloudFront with the token; a wrong token answers 401. */
export const frontDoorDrill: Drill = stubDrill("D3", "front-door");
/** The weekly restore test, on demand. */
export const restoreDrill: Drill = stubDrill("D3", "restore");

export const DRILLS: ReadonlyArray<Drill> = [
  smokeDrill,
  spotDrill,
  fallbackDrill,
  killDrill,
  frontDoorDrill,
  restoreDrill,
];
