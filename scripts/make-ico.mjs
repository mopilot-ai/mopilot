// Builds the Windows icons from build/icon.png (run on macOS, which has sips; the outputs are committed):
//   node scripts/make-ico.mjs
//   → build/icon.ico     app / installer icon, 16–256 px
//   → electron/tray.ico  notification-area icon, 16–48 px
// Sizes up to 48 px are stored as 32-bit BMP (DIB) entries, which every Windows tool reads (NSIS
// and rcedit among them); larger ones as PNG, as Windows itself does for 256 px.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const SRC = 'build/icon.png';

/** RGBA pixels of an 8-bit, non-interlaced RGB/RGBA PNG (what sips writes). */
export function decodePng(buf) {
  let pos = 8;
  let w, h, colorType, depth, interlace;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') [w, h, depth, colorType, interlace] = [data.readUInt32BE(0), data.readUInt32BE(4), data[8], data[9], data[12]];
    else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  if (depth !== 8 || interlace || (colorType !== 6 && colorType !== 2))
    throw new Error(`unsupported PNG (depth ${depth}, type ${colorType}, interlace ${interlace})`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c);
      const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
      line[i] = (line[i] + pred) & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      px[o] = line[x * bpp];
      px[o + 1] = line[x * bpp + 1];
      px[o + 2] = line[x * bpp + 2];
      px[o + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { w, h, px };
}

/** An ICO DIB entry: BITMAPINFOHEADER (double height), BGRA rows bottom-up, then the 1-bit AND mask. */
export function dib(png) {
  const { w, h, px } = decodePng(png);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(w, 4);
  header.writeInt32LE(h * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(w * h * 4, 20);
  const color = Buffer.alloc(w * h * 4);
  const maskStride = Math.ceil(w / 32) * 4;
  const mask = Buffer.alloc(maskStride * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = ((h - 1 - y) * w + x) * 4;
      color[d] = px[s + 2];
      color[d + 1] = px[s + 1];
      color[d + 2] = px[s];
      color[d + 3] = px[s + 3];
      if (px[s + 3] === 0) mask[(h - 1 - y) * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  return Buffer.concat([header, color, mask]);
}

/** An ICO of `sizes`, each square PNG coming from `resized(size)`. */
export function ico(sizes, resized) {
  const images = sizes.map((s) => {
    const png = resized(s);
    return { s, data: s <= 48 ? dib(png) : png };
  });
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ s, data }, i) => {
    const e = 6 + i * 16;
    head[e] = s >= 256 ? 0 : s;
    head[e + 1] = s >= 256 ? 0 : s;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.data)]);
}

/** Resizes build/icon.png with sips into a scratch folder and writes both icons (paths relative to the cwd). */
export function main({ exec = execFileSync, write = writeFileSync, log = console.log } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'mopilot-ico-'));
  const resized = (size) => {
    const out = path.join(tmp, `${size}.png`);
    exec('sips', ['-s', 'format', 'png', '-z', String(size), String(size), SRC, '--out', out], { stdio: 'ignore' });
    return readFileSync(out);
  };
  try {
    write('build/icon.ico', ico([16, 24, 32, 48, 64, 128, 256], resized));
    write('electron/tray.ico', ico([16, 20, 24, 32, 40, 48], resized));
    log('Wrote build/icon.ico and electron/tray.ico');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The command line: --help prints the usage, anything else writes the icons. */
export function cli(argv, { run = main, log = console.log } = {}) {
  if (argv.includes('--help'))
    log('usage: node scripts/make-ico.mjs (on macOS: writes build/icon.ico and electron/tray.ico from build/icon.png)');
  else run();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2));
