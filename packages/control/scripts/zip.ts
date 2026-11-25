// A minimal deterministic zip writer (deflate, fixed timestamps, sorted entries) for the control bundle, so the same
// source gives the same bytes and Terraform's `source_code_hash` changes only when the code does.
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export type ZipEntry = { readonly name: string; readonly data: Buffer };

// 1980-01-01 00:00, the earliest DOS date: no build-time clock in the archive.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const UNIX_FILE_0644 = (0o100644 << 16) >>> 0;

export function zip(entries: ReadonlyArray<ZipEntry>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
    const name = Buffer.from(e.name, "utf8");
    const packed = deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, zip 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(UNIX_FILE_0644, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Read back what `zip` wrote (tests and the build's self-check): every entry, by name. */
export function unzip(archive: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("not a zip archive");
  let at = archive.readUInt32LE(end + 16);
  const count = archive.readUInt16LE(end + 10);
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(at) !== 0x02014b50) throw new Error("bad central directory");
    const size = archive.readUInt32LE(at + 20);
    const nameLen = archive.readUInt16LE(at + 28);
    const extraLen = archive.readUInt16LE(at + 30);
    const commentLen = archive.readUInt16LE(at + 32);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.toString("utf8", at + 46, at + 46 + nameLen);
    const dataAt = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = inflateRawSync(archive.subarray(dataAt, dataAt + size));
    if (crc32(data) !== archive.readUInt32LE(at + 16)) throw new Error(`${name}: CRC mismatch`);
    out.set(name, data);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
