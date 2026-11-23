// Dependency-free PNG reader (8-bit RGB or RGBA, not interlaced) and writer (RGB or RGBA) for the phone app's icon generator.
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_TYPE_RGB = 2;
const COLOR_TYPE_RGBA = 6;

/** Reads the chunks of a PNG file into `{ type, data }` pairs; throws when the signature or a checksum is wrong. */
function readChunks(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');
  const chunks = [];
  for (let pos = 8; pos < buf.length; ) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (buf.readUInt32BE(pos + 8 + length) !== crc32(buf.subarray(pos + 4, pos + 8 + length))) throw new Error(`bad checksum in ${type}`);
    chunks.push({ type, data });
    pos += 12 + length;
  }
  return chunks;
}

/** Undoes the per-row filters of scanlines with `bpp` bytes per pixel and returns the raw pixel bytes. */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? out[y * stride + i - bpp] : 0;
      const up = y > 0 ? out[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= bpp ? out[(y - 1) * stride + i - bpp] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      out[y * stride + i] = (row[i] + predictor) & 0xff;
    }
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** @returns {{ width: number, height: number, data: Buffer }} RGBA pixels, row by row (RGB files get an opaque alpha). */
export function decodePng(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bpp = ihdr[9] === COLOR_TYPE_RGB ? 3 : 4;
  if (ihdr[8] !== 8 || (ihdr[9] !== COLOR_TYPE_RGB && ihdr[9] !== COLOR_TYPE_RGBA) || ihdr[12] !== 0) {
    throw new Error('only 8-bit RGB or RGBA PNGs without interlacing are supported');
  }
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const pixels = unfilter(raw, width, height, bpp);
  if (bpp === 4) return { width, height, data: pixels };
  const data = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i++) pixels.copy(data, i * 4, i * 3, i * 3 + 3);
  return { width, height, data };
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** Encodes RGBA pixels as a PNG; with `alpha` false the alpha channel is dropped (App Store icons must have none). */
export function encodePng({ width, height, data }, { alpha }) {
  const channels = alpha ? 4 : 3;
  const rows = Buffer.alloc((width * channels + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (width * channels + 1) + 1;
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) rows[at + x * channels + c] = data[(y * width + x) * 4 + c];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? COLOR_TYPE_RGBA : COLOR_TYPE_RGB;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Reads width, height and color type from a PNG header without decoding the pixels. */
export function pngInfo(buf) {
  const ihdr = readChunks(buf).find((c) => c.type === 'IHDR').data;
  return { width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4), colorType: ihdr[9] };
}
