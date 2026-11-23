// The Host's image reader (host/src/imageDecoder.mjs): a BMP becomes a PNG with node:zlib alone, what is not a BMP the machine may convert, and a file nothing can read gives null (B: external files of any shape).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { bmpToPng, convertImage } from '../host/src/imageDecoder.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-image-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A BMP of `rows` (each a list of [r, g, b, a?] pixels, top row first). */
function bmp(
  rows: number[][][],
  { bits = 24, topDown = false, compression = 0 }: { bits?: 24 | 32; topDown?: boolean; compression?: number } = {},
) {
  const width = rows[0].length;
  const height = rows.length;
  const stride = Math.ceil((width * bits) / 32) * 4;
  const out = Buffer.alloc(54 + stride * height);
  out.write('BM', 0);
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(topDown ? -height : height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(bits, 28);
  out.writeUInt32LE(compression, 30);
  rows.forEach((row, y) => {
    const at = 54 + (topDown ? y : height - 1 - y) * stride;
    row.forEach(([r, g, b, a = 0], x) => out.set(bits === 24 ? [b, g, r] : [b, g, r, a], at + x * (bits / 8)));
  });
  return out;
}

/** The RGBA pixels of a PNG this module wrote: its chunks are checked on the way (signature, order, CRC). */
function decode(png: Buffer) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  const types: string[] = [];
  let width = 0;
  let height = 0;
  let idat: Buffer = Buffer.alloc(0);
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    assert.equal(png.readUInt32BE(at + 8 + length), zlib.crc32(png.subarray(at + 4, at + 8 + length)), `${type} CRC`);
    types.push(type);
    if (type === 'IHDR') [width, height] = [body.readUInt32BE(0), body.readUInt32BE(4)];
    if (type === 'IDAT') idat = body;
    at += 12 + length;
  }
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
  const raw = zlib.inflateSync(idat);
  const rows: number[][][] = [];
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width * 4 + 1)], 0, 'no filter');
    const row: number[][] = [];
    for (let x = 0; x < width; x++) row.push([...raw.subarray(y * (width * 4 + 1) + 1 + x * 4, y * (width * 4 + 1) + 5 + x * 4)]);
    rows.push(row);
  }
  return rows;
}

test('B: a bottom-up 24-bit BMP, padding and all, comes out as the same picture, top row first', () => {
  const rows = [
    [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ],
    [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ],
  ];
  const png = bmpToPng(bmp(rows));
  assert.ok(png);
  assert.deepEqual(
    decode(png),
    rows.map((r) => r.map((p) => [...p, 255])),
  );
});

test('B: a top-down BMP keeps its row order, and a 32-bit one keeps its alpha when any pixel has it', () => {
  const rows = [[[10, 20, 30, 128]], [[40, 50, 60, 255]]];
  assert.deepEqual(decode(bmpToPng(bmp(rows, { bits: 32, topDown: true }))!), rows);
  assert.deepEqual(decode(bmpToPng(bmp(rows, { bits: 32, compression: 3 }))!), rows);
});

test('B: a 32-bit BMP whose alpha bytes are all zero is opaque', () => {
  const png = bmpToPng(
    bmp(
      [
        [
          [9, 8, 7, 0],
          [6, 5, 4, 0],
        ],
      ],
      { bits: 32 },
    ),
  );
  assert.deepEqual(decode(png!), [
    [
      [9, 8, 7, 255],
      [6, 5, 4, 255],
    ],
  ]);
});

test('B: what is not a plain BMP gives null instead of a wrong picture', () => {
  const ok = bmp([[[1, 2, 3]]]);
  const set = (f: (b: Buffer) => void) => {
    const copy = Buffer.from(ok);
    f(copy);
    return bmpToPng(copy);
  };
  assert.equal(bmpToPng(Buffer.from('GIF89a')), null, 'not a BMP');
  assert.equal(bmpToPng(ok.subarray(0, 30)), null, 'cut short');
  assert.equal(
    set((b) => b.writeUInt32LE(12, 14)),
    null,
    'an old header',
  );
  assert.equal(
    set((b) => b.writeUInt16LE(8, 28)),
    null,
    'a palette',
  );
  assert.equal(
    set((b) => b.writeUInt32LE(1, 30)),
    null,
    'run-length encoded',
  );
  assert.equal(
    set((b) => b.writeUInt32LE(3, 30)),
    null,
    'bit fields in a 24-bit file',
  );
  assert.equal(
    set((b) => b.writeInt32LE(0, 18)),
    null,
    'no width',
  );
  assert.equal(
    set((b) => b.writeInt32LE(0, 22)),
    null,
    'no height',
  );
  assert.equal(
    set((b) => (b.writeInt32LE(5000, 18), b.writeInt32LE(5000, 22))),
    null,
    'too many pixels',
  );
  assert.equal(bmpToPng(ok.subarray(0, 55)), null, 'pixels missing');
});

test('B: a BMP file is converted, and a file that is neither BMP nor anything the machine converts gives null', async () => {
  const file = path.join(dir, 'a.bmp');
  fs.writeFileSync(file, bmp([[[1, 2, 3]]]));
  assert.deepEqual(decode((await convertImage(file))!), [[[1, 2, 3, 255]]]);
  // a BMP this module does not decode (a palette) is the machine's to convert: a picture where it can, null where it cannot
  const palette = path.join(dir, 'p.bmp');
  const bytes = bmp([[[1, 2, 3]]]);
  bytes.writeUInt16LE(8, 28);
  fs.writeFileSync(palette, bytes);
  const converted = await convertImage(palette);
  assert.ok(converted === null || Buffer.isBuffer(converted));
  const other = path.join(dir, 'b.heic');
  fs.writeFileSync(other, 'not an image');
  assert.equal(await convertImage(other), null);
});
