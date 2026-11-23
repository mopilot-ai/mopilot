// Extracts Host downloads and ACP agent ZIP archives through one guarded Node platform implementation.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

export class ZipError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ZipError';
    this.code = 'bad_zip';
  }
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** The most an archive may unpack to: a bound against a bomb. */
const MAX_TOTAL = 2 * 1024 ** 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/** The entries of the zip in `file`, from its central directory. @param {fs.promises.FileHandle} handle @param {number} size */
async function entriesOf(handle, size) {
  const tail = Buffer.alloc(Math.min(size, 65_557));
  await handle.read(tail, 0, tail.length, size - tail.length);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new ZipError('That is not a zip file.');
  const count = tail.readUInt16LE(at + 10);
  const cdSize = tail.readUInt32LE(at + 12);
  const cdOffset = tail.readUInt32LE(at + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('A zip64 archive is not supported.');
  const cd = Buffer.alloc(cdSize);
  await handle.read(cd, 0, cdSize, cdOffset);
  /** @type {{ name: string, method: number, compressed: number, size: number, mode: number, offset: number }[]} */
  const out = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL) throw new ZipError('The zip directory is damaged.');
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const unix = cd.readUInt8(p + 5) === 3;
    out.push({
      name: cd.toString('utf8', p + 46, p + 46 + nameLen),
      method: cd.readUInt16LE(p + 10),
      compressed: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      mode: unix ? cd.readUInt32LE(p + 38) >>> 16 : 0,
      offset: cd.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Where an entry's name goes under `dest`, or a refusal for one that would leave it. @param {string} dest @param {string} name */
function placeOf(dest, name) {
  if (!name || name.includes('\0') || name.includes('\\') || path.posix.isAbsolute(name))
    throw new ZipError(`The zip holds a path it should not: ${JSON.stringify(name)}.`);
  const parts = name.split('/').filter(Boolean);
  if (parts.includes('..')) throw new ZipError(`The zip holds a path it should not: ${JSON.stringify(name)}.`);
  return path.join(dest, ...parts);
}

/**
 * Unpacks `file` into `dest` (made if missing).
 * @param {string} file
 * @param {string} dest
 */
export async function extractZip(file, dest) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const entries = await entriesOf(handle, size);
    let total = 0;
    await fs.promises.mkdir(dest, { recursive: true, mode: 0o700 });
    for (const e of entries) {
      const target = placeOf(dest, e.name);
      const kind = e.mode & S_IFMT;
      if (e.name.endsWith('/') || kind === S_IFDIR) {
        await fs.promises.mkdir(target, { recursive: true, mode: 0o700 });
        continue;
      }
      if (kind !== 0 && kind !== S_IFREG) throw new ZipError(`The zip holds a link or special file: ${JSON.stringify(e.name)}.`);
      if (e.method !== 0 && e.method !== 8) throw new ZipError('The zip uses a compression this Host cannot read.');
      total += e.size;
      if (total > MAX_TOTAL) throw new ZipError('The zip unpacks to more than allowed.');
      const local = Buffer.alloc(30);
      await handle.read(local, 0, 30, e.offset);
      if (local.readUInt32LE(0) !== LOCAL) throw new ZipError('The zip directory is damaged.');
      const start = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const mode = e.mode & 0o777 || 0o644;
      let written = 0;
      if (e.compressed > 0) {
        const count = async function* (/** @type {AsyncIterable<Buffer>} */ chunks) {
          for await (const c of chunks) {
            written += c.length;
            if (written > e.size) throw new ZipError('A file in the zip is larger than it says.');
            yield c;
          }
        };
        const raw = fs.createReadStream(file, { start, end: start + e.compressed - 1 });
        await pipeline([raw, ...(e.method === 8 ? [zlib.createInflateRaw()] : []), count, fs.createWriteStream(target, { mode })]);
      } else {
        await fs.promises.writeFile(target, '', { mode });
      }
      // the process's umask must not take the executable bit away
      await fs.promises.chmod(target, mode);
      if (written !== e.size) throw new ZipError('A file in the zip is shorter than it says.');
    }
  } finally {
    await handle.close();
  }
}
