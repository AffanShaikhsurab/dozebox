// An in-memory Parameter Store behind a stubbed SSM client, for offline adapter tests: PutParameter (Overwrite,
// tiers, no downgrade from Advanced), GetParameter, GetParametersByPath (Recursive, MaxResults, NextToken),
// DeleteParameter, with the error names SSM returns. Only what the record adapters send.
import { sdkError, stubSdk, type SdkStub } from "./stub.ts";

export type SsmParameter = {
  readonly value: string;
  readonly type: string;
  readonly tier: string;
  readonly modifiedAt: number;
};

export type SsmMemory = {
  readonly stub: SdkStub;
  readonly parameters: Map<string, SsmParameter>;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function ssmMemory(client: object, now: () => number = Date.now): SsmMemory {
  const stub = stubSdk(client);
  const parameters = new Map<string, SsmParameter>();
  const view = (name: string, p: SsmParameter) => ({
    Name: name,
    Value: p.value,
    Type: p.type,
    LastModifiedDate: new Date(p.modifiedAt),
  });
  stub.on("PutParameterCommand", (input) => {
    const name = str(input["Name"]);
    const tier = str(input["Tier"]) || "Standard";
    const old = parameters.get(name);
    if (old && input["Overwrite"] !== true) throw sdkError("ParameterAlreadyExists", 400);
    if (old?.tier === "Advanced" && tier === "Standard") {
      throw sdkError(
        "ValidationException",
        400,
        "This parameter uses the advanced-parameter tier. You can't downgrade a parameter from the " +
          "advanced-parameter tier to the standard-parameter tier.",
      );
    }
    const limit = tier === "Advanced" ? 8192 : 4096;
    const value = str(input["Value"]);
    if (new TextEncoder().encode(value).length > limit) throw sdkError("ValidationException", 400, "value too large");
    parameters.set(name, { value, type: str(input["Type"]) || "String", tier, modifiedAt: now() });
    return { Version: 1, Tier: tier };
  });
  stub.on("GetParameterCommand", (input) => {
    const name = str(input["Name"]);
    const p = parameters.get(name);
    if (!p) throw sdkError("ParameterNotFound", 400);
    return { Parameter: view(name, p) };
  });
  stub.on("GetParametersByPathCommand", (input) => {
    const path = `${str(input["Path"]).replace(/\/$/, "")}/`;
    const recursive = input["Recursive"] === true;
    const max = typeof input["MaxResults"] === "number" ? input["MaxResults"] : 10;
    if (max > 10) throw sdkError("ValidationException", 400, "MaxResults over 10");
    const names = [...parameters.keys()]
      .filter((n) => n.startsWith(path) && (recursive || !n.slice(path.length).includes("/")))
      .toSorted();
    const start = Number(str(input["NextToken"]) || "0");
    const page = names.slice(start, start + max);
    const next = start + max < names.length ? String(start + max) : undefined;
    return {
      Parameters: page.map((n) => {
        const p = parameters.get(n);
        if (!p) throw new Error("unreachable");
        return view(n, p);
      }),
      ...(next === undefined ? {} : { NextToken: next }),
    };
  });
  stub.on("DeleteParameterCommand", (input) => {
    if (!parameters.delete(str(input["Name"]))) throw sdkError("ParameterNotFound", 400);
    return {};
  });
  return { stub, parameters };
}
