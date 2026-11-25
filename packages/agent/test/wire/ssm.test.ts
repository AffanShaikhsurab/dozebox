// Wire: the box's record writer against the emulator (`pnpm test:wire`; skips when the emulator is not running).
// The box never reads records, so the contract's reader is a plain SSM read in this test.
import { GetParameterCommand, GetParametersByPathCommand, SSMClient, type Parameter } from "@aws-sdk/client-ssm";
import { fromAws } from "@dozebox/core/errors";
import { fresh, recordStoreContract } from "@dozebox/testkit/contracts";
import { countCalls, faultInjector, resolveWire } from "@dozebox/testkit/wire";
import { makeAwsRecordWriter } from "../../src/adapters/aws/ssm.ts";

const target = await resolveWire();

const stored = (root: string, p: Parameter | undefined) =>
  p?.Name && p.Value !== undefined
    ? { name: p.Name.slice(root.length), value: p.Value, modifiedAt: p.LastModifiedDate?.getTime() ?? 0 }
    : null;

recordStoreContract(
  "aws ssm record writer on the emulator",
  async () => {
    const root = `/dozebox/${fresh("box")}/`;
    const ssm = new SSMClient(target.config);
    const inject = faultInjector(ssm);
    const calls = countCalls(ssm);
    const reads = new SSMClient(target.config);
    const injectRead = faultInjector(reads);
    return {
      writer: makeAwsRecordWriter({ ssm, root }),
      reader: {
        get: async (name) => {
          try {
            return stored(root, (await reads.send(new GetParameterCommand({ Name: `${root}${name}` }))).Parameter);
          } catch (e) {
            const err = fromAws(e);
            if (err.code === "aws_not_found") return null;
            throw err;
          }
        },
        readAll: async () => {
          const out = [];
          let next: string | undefined;
          do {
            const page = await reads.send(
              new GetParametersByPathCommand({
                Path: root.slice(0, -1),
                Recursive: true,
                ...(next === undefined ? {} : { NextToken: next }),
              }),
            );
            for (const p of page.Parameters ?? []) {
              const r = stored(root, p);
              if (r) out.push(r);
            }
            next = page.NextToken;
          } while (next);
          return out;
        },
      },
      calls,
      inject: (op, name, status) =>
        op === "put" ? inject("PutParameterCommand", name, status) : injectRead("GetParameterCommand", name, status),
    };
  },
  { skip: target.skip },
);
