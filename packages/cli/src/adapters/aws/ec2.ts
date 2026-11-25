// Snapshots and volumes through the EC2 API. Nothing here deletes a volume.
import {
  CreateSnapshotCommand,
  CreateTagsCommand,
  CreateVolumeCommand,
  DeleteSnapshotCommand,
  DescribeSnapshotsCommand,
  DescribeVolumesCommand,
  type EC2Client,
  type Filter,
  type Snapshot,
  type Tag,
  type Volume,
} from "@aws-sdk/client-ec2";
import { fromAws, RunnerError } from "@dozebox/core/errors";
import type { AwsOps, CliVolumeView, SnapshotView } from "../../ports/aws.ts";

export type Ec2Ops = Pick<
  AwsOps,
  "snapshots" | "createSnapshot" | "deleteSnapshot" | "volumes" | "createVolume" | "retireVolume"
>;

const tagOf = (tags: ReadonlyArray<Tag> | undefined, key: string): string | undefined =>
  tags?.find((t) => t.Key === key)?.Value;

const wrap = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (e) {
    throw fromAws(e);
  }
};

async function describeSnapshots(
  ec2: EC2Client,
  input: { readonly Filters?: Filter[]; readonly SnapshotIds?: string[] },
): Promise<Snapshot[]> {
  const found: Snapshot[] = [];
  let next: string | undefined;
  do {
    const out = await ec2.send(new DescribeSnapshotsCommand({ ...input, OwnerIds: ["self"], NextToken: next }));
    found.push(...(out.Snapshots ?? []));
    next = out.NextToken;
  } while (next);
  return found;
}

async function describeVolumes(
  ec2: EC2Client,
  input: { readonly Filters?: Filter[]; readonly VolumeIds?: string[] },
): Promise<Volume[]> {
  const found: Volume[] = [];
  let next: string | undefined;
  do {
    const out = await ec2.send(new DescribeVolumesCommand({ ...input, NextToken: next }));
    found.push(...(out.Volumes ?? []));
    next = out.NextToken;
  } while (next);
  return found;
}

const createdAt = (v: Volume): number => v.CreateTime?.getTime() ?? 0;

function snapshotState(state: string | undefined): SnapshotView["state"] {
  if (state === "completed" || state === "error") return state;
  return "pending";
}

export function makeEc2Ops(ec2: EC2Client, p: string): Ec2Ops {
  const boxTag = `${p}:box`;
  const labelTag = `${p}:label`;
  const tokenTag = `${p}:snapshot-token`;
  const activeTag = `${p}:active`;
  const retiredTag = `${p}:retired`;

  const toSnapshotView = (s: Snapshot): SnapshotView => ({
    id: s.SnapshotId ?? "",
    volumeId: s.VolumeId ?? "",
    state: snapshotState(s.State),
    startedAt: s.StartTime?.getTime() ?? 0,
    label: tagOf(s.Tags, labelTag) ?? null,
  });

  const toVolumeView = (v: Volume): CliVolumeView => ({
    id: v.VolumeId ?? "",
    zone: v.AvailabilityZone ?? "",
    state: v.State ?? "",
    active: tagOf(v.Tags, activeTag) === "true",
    retired: tagOf(v.Tags, retiredTag) !== undefined,
  });

  /** Tags copied from a snapshot onto its new volume. */
  const inheritable = (tags: ReadonlyArray<Tag> | undefined): Tag[] =>
    (tags ?? []).filter(
      (t): t is Tag & { Key: string } =>
        t.Key !== undefined &&
        !t.Key.startsWith("aws:") &&
        !t.Key.startsWith(`${p}:snapshot`) &&
        t.Key !== labelTag &&
        t.Key !== activeTag &&
        t.Key !== retiredTag &&
        t.Key !== boxTag,
    );

  return {
    snapshots: (box) =>
      wrap(async () => {
        const all = await describeSnapshots(ec2, { Filters: [{ Name: `tag:${boxTag}`, Values: [box] }] });
        return all.map(toSnapshotView).toSorted((a, b) => b.startedAt - a.startedAt);
      }),

    createSnapshot: (volumeId, label, token) =>
      wrap(async () => {
        const existing = await describeSnapshots(ec2, { Filters: [{ Name: `tag:${tokenTag}`, Values: [token] }] });
        const known = existing[0]?.SnapshotId;
        if (known) return known;
        const [volume] = await describeVolumes(ec2, { VolumeIds: [volumeId] });
        const box = tagOf(volume?.Tags, boxTag);
        const name = tagOf(volume?.Tags, "Name");
        const tags: Tag[] = [
          ...(name === undefined ? [] : [{ Key: "Name", Value: name }]),
          ...(box === undefined ? [] : [{ Key: boxTag, Value: box }]),
          { Key: labelTag, Value: label },
          { Key: tokenTag, Value: token },
          { Key: `${p}:snapshot`, Value: "cli" },
        ];
        const out = await ec2.send(
          new CreateSnapshotCommand({
            VolumeId: volumeId,
            TagSpecifications: [{ ResourceType: "snapshot", Tags: tags }],
          }),
        );
        if (!out.SnapshotId) throw new RunnerError("internal", false, "CreateSnapshot returned no snapshot id");
        return out.SnapshotId;
      }),

    deleteSnapshot: (id) =>
      wrap(async () => {
        await ec2.send(new DeleteSnapshotCommand({ SnapshotId: id }));
      }),

    volumes: (box) =>
      wrap(async () => {
        const all = await describeVolumes(ec2, { Filters: [{ Name: `tag:${boxTag}`, Values: [box] }] });
        return all.toSorted((a, b) => createdAt(a) - createdAt(b)).map(toVolumeView);
      }),

    createVolume: ({ snapshotId, zone, boxId, token }) =>
      wrap(async () => {
        const [snap] = await describeSnapshots(ec2, { SnapshotIds: [snapshotId] });
        const tags: Tag[] = [
          ...inheritable(snap?.Tags),
          { Key: boxTag, Value: boxId },
          { Key: activeTag, Value: "false" },
        ];
        const out = await ec2.send(
          new CreateVolumeCommand({
            ClientToken: token,
            Encrypted: true,
            VolumeType: "gp3",
            AvailabilityZone: zone,
            SnapshotId: snapshotId,
            ...(snap?.VolumeSize === undefined ? {} : { Size: snap.VolumeSize }),
            Iops: 3000,
            Throughput: 125,
            TagSpecifications: [{ ResourceType: "volume", Tags: tags }],
          }),
        );
        if (!out.VolumeId) throw new RunnerError("internal", false, "CreateVolume returned no volume id");
        return out.VolumeId;
      }),

    retireVolume: (id) =>
      wrap(async () => {
        await ec2.send(
          new CreateTagsCommand({
            Resources: [id],
            Tags: [
              { Key: activeTag, Value: "false" },
              { Key: retiredTag, Value: new Date().toISOString() },
            ],
          }),
        );
      }),
  };
}
