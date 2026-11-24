import { createFsFromVolume, Volume } from "memfs";

export type FakeFs = {
  /** A node:fs-compatible module over memory: pass it where code takes an `fs`. */
  readonly fs: ReturnType<typeof createFsFromVolume>;
  readonly vol: InstanceType<typeof Volume>;
  /** Every file as path -> text, for asserting on what was written. */
  readonly snapshot: () => Record<string, string | null>;
};

/** An in-memory filesystem seeded with `files` (absolute path -> text). */
export function makeFakeFs(files: Readonly<Record<string, string>> = {}): FakeFs {
  const vol = Volume.fromJSON({ ...files });
  return { fs: createFsFromVolume(vol), vol, snapshot: () => vol.toJSON() };
}
