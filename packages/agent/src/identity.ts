// Who this agent is: the box (from the unit's environment), the instance (IMDS) and this boot (the kernel's boot id).
// The writer tag on every record is `{ instanceId, bootId }` (part 9 R4).
import type { WriterTag } from "@dozebox/protocol/records";
import type { AgentEnv } from "./env.ts";
import type { Files } from "./ports/files.ts";
import type { Imds } from "./ports/imds.ts";

export const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

export type Identity = {
  readonly boxId: string;
  readonly prefix: string;
  readonly region: string;
  readonly instanceId: string;
  readonly availabilityZone: string;
  readonly instanceType: string;
  readonly bootId: string;
  /** The parameter root `/<prefix>/<boxId>/`. */
  readonly root: string;
};

export const writerOf = (id: Identity): WriterTag => ({ instanceId: id.instanceId, bootId: id.bootId });

export async function resolveIdentity(
  env: AgentEnv,
  deps: { readonly imds: Imds; readonly files: Files; readonly signal?: AbortSignal },
): Promise<Identity> {
  const facts = await deps.imds.instance(deps.signal);
  const bootId = (await deps.files.readText(BOOT_ID_PATH))?.trim().replaceAll("-", "") ?? "";
  if (bootId.length < 8) throw new Error(`no boot id in ${BOOT_ID_PATH}`);
  return {
    boxId: env.boxId,
    prefix: env.prefix,
    region: env.region ?? facts.region,
    instanceId: facts.instanceId,
    availabilityZone: facts.availabilityZone,
    instanceType: facts.instanceType,
    bootId,
    root: `/${env.prefix}/${env.boxId}/`,
  };
}
