// DEV ONLY: generated test pictures (a tall screenshot-like one, a wide one, a square one) as base64 PNGs, each a labelled grid so zoom, pan and the tap point are visible.
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (/** @type {Buffer} */ b) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (/** @type {string} */ type, /** @type {Buffer} */ data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(4 + body.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), 4 + body.length);
  return out;
};

/** A w x h PNG: a colour gradient with a grid line every 50 px (thicker every 250) and a bright cross at the centre. */
export function gridPng(/** @type {number} */ w, /** @type {number} */ h, /** @type {[number, number, number]} */ tint) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x += 1) {
      const line = x % 50 < 2 || y % 50 < 2;
      const thick = x % 250 < 4 || y % 250 < 4;
      const centre = Math.abs(x - w / 2) < 6 || Math.abs(y - h / 2) < 6;
      const o = row + 1 + x * 3;
      const g = (x / w + y / h) / 2;
      const px = centre ? [255, 255, 255] : thick ? [20, 20, 20] : line ? [90, 90, 90] : tint.map((t) => Math.round(t * (0.5 + 0.5 * g)));
      raw[o] = px[0];
      raw[o + 1] = px[1];
      raw[o + 2] = px[2];
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}
