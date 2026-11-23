// Writes a plain deflate zip of named files (no dependencies), with fixed timestamps so the same files give the same bytes; used for the Chrome Web Store upload.
import fs from 'node:fs';
import zlib from 'node:zlib';

/** 1980-01-01 00:00, the earliest DOS date: every entry gets it, so a rebuild of the same files is byte-identical. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/**
 * The zip archive of `entries`, in their order. Names use forward slashes and are stored as UTF-8.
 * @param {{ name: string, data: Buffer | string }[]} entries
 * @returns {Buffer}
 */
export function zipBuffer(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    // version 2.0, UTF-8 names (bit 11), deflate (8)
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // extra, comment, disk, internal attributes, external attributes: none
    central.writeUInt32LE(offset, 42);
    locals.push(head, name, packed);
    centrals.push(central, name);
    offset += head.length + name.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/** Writes the zip of `entries` to `file`. @param {string} file @param {{ name: string, data: Buffer | string }[]} entries */
export function writeZip(file, entries) {
  fs.writeFileSync(file, zipBuffer(entries));
}
