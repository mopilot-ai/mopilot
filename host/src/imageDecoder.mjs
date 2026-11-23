// The image reader the Host installs behind the chat code's `convert` port (electron/harness/claude/message.cjs): the formats the model APIs take (JPEG, PNG, GIF, WebP) go through as they are, a BMP is turned into a PNG here with node:zlib alone, and any other format is left to what the machine has (macOS's `sips`); a file nothing can read gives null, and the message says the image could not be attached.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const { toPng } = require('../../electron/harness/claude/message.cjs');

/** Largest picture decoded here (pixels): a BMP of this size is 64 MB of RGBA. */
const MAX_PIXELS = 16_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** @param {Buffer} bytes */
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk. @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** Whether any pixel of a 32-bit BMP has an alpha byte; a file with none writes zeros for the unused byte. @param {Buffer} bmp @param {number} at @param {number} stride @param {number} width @param {number} height */
function hasAlpha(bmp, at, stride, width, height) {
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (bmp[at + y * stride + x * 4 + 3] !== 0) return true;
  return false;
}

/**
 * A 24- or 32-bit uncompressed BMP as a PNG; null for anything else (palettes, RLE, a damaged file).
 * @param {Buffer} bmp
 * @returns {Buffer | null}
 */
export function bmpToPng(bmp) {
  if (bmp.length < 54 || bmp.toString('latin1', 0, 2) !== 'BM') return null;
  const dataAt = bmp.readUInt32LE(10);
  const headerSize = bmp.readUInt32LE(14);
  if (headerSize < 40) return null;
  const width = bmp.readInt32LE(18);
  const signedHeight = bmp.readInt32LE(22);
  const bits = bmp.readUInt16LE(28);
  const compression = bmp.readUInt32LE(30);
  const height = Math.abs(signedHeight);
  // BI_RGB, or BI_BITFIELDS as every 32-bit writer lays it out (BGRA)
  if (width <= 0 || height === 0 || (bits !== 24 && bits !== 32) || (compression !== 0 && !(compression === 3 && bits === 32))) return null;
  if (width * height > MAX_PIXELS) return null;
  const bytes = bits / 8;
  // rows are padded to four bytes; a positive height means the bottom row comes first
  const stride = Math.ceil((width * bits) / 32) * 4;
  if (dataAt + stride * (height - 1) + width * bytes > bmp.length) return null;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const alpha = bits === 32 && hasAlpha(bmp, dataAt, stride, width, height);
  for (let y = 0; y < height; y++) {
    const from = dataAt + (signedHeight > 0 ? height - 1 - y : y) * stride;
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      const s = from + x * bytes;
      const d = row + 1 + x * 4;
      raw[d] = bmp[s + 2];
      raw[d + 1] = bmp[s + 1];
      raw[d + 2] = bmp[s];
      // a 32-bit BMP whose alpha bytes are all zero is opaque
      raw[d + 3] = alpha ? bmp[s + 3] : 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * The `convert` the chat code calls for a file the model APIs cannot take: a BMP here, the rest as the machine allows.
 * @param {string} file
 * @returns {Promise<Buffer | null>}
 */
export async function convertImage(file) {
  // only a BMP is read whole here: any other file is the machine's to convert
  const head = Buffer.alloc(2);
  const handle = await fs.promises.open(file, 'r');
  try {
    await handle.read(head, 0, 2, 0);
  } finally {
    await handle.close();
  }
  return head.toString('latin1') === 'BM' ? (bmpToPng(await fs.promises.readFile(file)) ?? toPng(file)) : toPng(file);
}
