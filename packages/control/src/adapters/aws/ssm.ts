// AWS adapter for the box's records: SSM Parameter Store parameters under `/<prefix>/<boxId>/` (part 4 §4.14).
// Every value is a plain `String` parameter written with `Overwrite`. The tier is the one the record registry gives
// (Standard 4 KiB, Advanced 8 KiB for `rec/liveness` and `rec/wakes`); size and name are checked before any call.
// Advanced is one-way (notes/06b §1.10): a Standard write to a parameter that is already Advanced is refused by SSM,
// so that write is repeated once as Advanced, which costs nothing extra (the parameter is billed as Advanced anyway).
// Reads are one paginated GetParametersByPath per tick (at most 10 per page); SecureString parameters are skipped.
import {
  DeleteParameterCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
  type Parameter,
  type SSMClient,
} from "@aws-sdk/client-ssm";
import { fromAws, type RunnerError } from "@dozebox/core/errors";
import { assertFits, type Tier } from "@dozebox/core/records";
import type { RecordStore, StoredRecord } from "../../ports/records.ts";

export type AwsRecordStoreDeps = {
  readonly ssm: SSMClient;
  /** The box root, such as `/dozebox/box-1/`: starts and ends with `/`. */
  readonly root: string;
};

const ROOT = /^\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\/$/;

/** Throws on a malformed root (a wiring bug, not a runtime outcome). */
function checkRoot(root: string): string {
  if (!ROOT.test(root)) throw new Error(`"${root}" is not a parameter root like /dozebox/box-1/`);
  return root;
}

/** SSM's answer to a Standard write over an Advanced parameter. */
const isTierDowngrade = (e: RunnerError): boolean => e.code === "invalid_input" && /downgrade/i.test(e.message);

/** PutParameter with the registry's tier, repeated once as Advanced when SSM refuses a downgrade. */
async function putRecord(ssm: SSMClient, root: string, name: string, value: string, tier: Tier): Promise<void> {
  assertFits(name, value, tier);
  const put = (t: Tier) =>
    ssm.send(
      new PutParameterCommand({ Name: `${root}${name}`, Value: value, Type: "String", Tier: t, Overwrite: true }),
    );
  try {
    await put(tier);
  } catch (e) {
    const err = fromAws(e);
    if (tier === "Advanced" || !isTierDowngrade(err)) throw err;
    try {
      await put("Advanced");
    } catch (again) {
      throw fromAws(again);
    }
  }
}

/** DeleteParameter; a missing parameter is not an error. */
async function deleteRecord(ssm: SSMClient, root: string, name: string): Promise<void> {
  assertFits(name, "", "Standard");
  try {
    await ssm.send(new DeleteParameterCommand({ Name: `${root}${name}` }));
  } catch (e) {
    const err = fromAws(e);
    if (err.code !== "aws_not_found") throw err;
  }
}

function toStored(root: string, p: Parameter): StoredRecord | null {
  if (p.Name === undefined || !p.Name.startsWith(root) || p.Value === undefined) return null;
  // A SecureString (the wake token) is never a record; its ciphertext stays out of every snapshot.
  if (p.Type === "SecureString") return null;
  return { name: p.Name.slice(root.length), value: p.Value, modifiedAt: p.LastModifiedDate?.getTime() ?? 0 };
}

export function makeAwsRecordStore(deps: AwsRecordStoreDeps): RecordStore {
  const { ssm } = deps;
  const root = checkRoot(deps.root);
  return {
    readAll: async () => {
      const out: StoredRecord[] = [];
      let next: string | undefined;
      try {
        do {
          const page = await ssm.send(
            new GetParametersByPathCommand({
              Path: root.slice(0, -1),
              Recursive: true,
              MaxResults: 10,
              ...(next === undefined ? {} : { NextToken: next }),
            }),
          );
          for (const p of page.Parameters ?? []) {
            const r = toStored(root, p);
            if (r) out.push(r);
          }
          next = page.NextToken;
        } while (next);
      } catch (e) {
        throw fromAws(e);
      }
      return out.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    get: async (name) => {
      assertFits(name, "", "Standard");
      try {
        const out = await ssm.send(new GetParameterCommand({ Name: `${root}${name}` }));
        return out.Parameter ? toStored(root, out.Parameter) : null;
      } catch (e) {
        const err = fromAws(e);
        if (err.code === "aws_not_found") return null;
        throw err;
      }
    },
    put: (name, value, { tier }) => putRecord(ssm, root, name, value, tier),
    delete: (name) => deleteRecord(ssm, root, name),
  };
}
