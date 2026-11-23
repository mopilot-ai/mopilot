// Builds small zip archives for the extractor's tests (host/src/zipExtract.mjs): stored or deflated entries, unix modes, and damaged forms.
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data?: string | Buffer;
  /** the unix mode (high 16 bits of the external attributes); default 0o100644 */
  mode?: number;
  /** 0 = stored, 8 = deflated (default) */
  method?: 0 | 8 | 99;
  /** what the directory claims the size to be, when it should differ from the data */
  claimSize?: number;
}

/** A zip of `entries`; `noUnix` writes a DOS-made archive (no unix modes). */
export function zip(entries: ZipEntry[], { noUnix = false, omitEocd = false, zip64 = false, badCentral = false } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data ?? '');
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name);
    const isDir = e.name.endsWith('/');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const extra = Buffer.from([1, 2, 3, 4]);
    local.writeUInt16LE(extra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(badCentral ? 0xdeadbeef : 0x02014b50, 0);
    central.writeUInt8(noUnix ? 0 : 3, 5);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(isDir ? 0 : body.length, 20);
    central.writeUInt32LE(e.claimSize ?? (isDir ? 0 : raw.length), 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(noUnix ? 0 : ((e.mode ?? (isDir ? 0o040755 : 0o100644)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, extra, isDir ? Buffer.alloc(0) : body);
    centrals.push(central, name, extra);
    offset += 30 + name.length + extra.length + (isDir ? 0 : body.length);
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(omitEocd ? 0 : 0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
