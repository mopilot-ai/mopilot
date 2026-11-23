// An animated GIF from BGRA frames, for browser_gif_creator (gifRecorder.cjs): a fixed 252-color palette with ordered dithering, only the rectangle that changed in each frame, and LZW.
//
// Browser recordings are mostly still UI with small changes between steps, so a fixed palette (6 red x 7 green x 6 blue
// levels) with a 4x4 Bayer dither reads well, needs no quantizer, and lets each frame after the first carry only the
// box of pixels whose palette index changed (disposal "leave in place"). A frame with no change lengthens the previous
// frame's delay instead of adding one.

const R = 6;
const G = 7;
const B = 6;
/** 4x4 Bayer matrix, centered on 0 (-0.5 .. 0.44), times one palette step when dithering. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => v / 16 - 0.5);

/** The palette: 256 RGB entries (the last 4 are unused black). */
function palette() {
  const p = Buffer.alloc(256 * 3);
  let i = 0;
  for (let r = 0; r < R; r++)
    for (let g = 0; g < G; g++)
      for (let b = 0; b < B; b++) {
        p[i++] = Math.round((r * 255) / (R - 1));
        p[i++] = Math.round((g * 255) / (G - 1));
        p[i++] = Math.round((b * 255) / (B - 1));
      }
  return p;
}
const PALETTE = palette();

/** One level of a channel with `n` levels, dithered by `d`: d is in [-0.5, 0.4375], so it rounds into 0..n-1. */
const level = (v, n, d) => Math.round((v * (n - 1)) / 255 + d);

/**
 * Palette indices of a BGRA bitmap placed at the top left of a `w` x `h` screen (outside it: index 0, black).
 * @param {{ width: number, height: number, bgra: Uint8Array }} f
 */
function indices(f, w, h) {
  const out = new Uint8Array(w * h);
  const fw = Math.min(f.width, w);
  const fh = Math.min(f.height, h);
  for (let y = 0; y < fh; y++)
    for (let x = 0; x < fw; x++) {
      const s = (y * f.width + x) * 4;
      const d = BAYER[(y & 3) * 4 + (x & 3)];
      out[y * w + x] = level(f.bgra[s + 2], R, d) * G * B + level(f.bgra[s + 1], G, d) * B + level(f.bgra[s], B, d);
    }
  return out;
}

/** The box where `a` and `b` differ, or null when they are the same. */
function changed(a, b, w, h) {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++)
      if (a[row + x] !== b[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** GIF LZW of 8-bit indices, as data sub-blocks ending with the block terminator. */
function lzw(px) {
  const out = [];
  let block = [];
  let acc = 0;
  let bits = 0;
  const byte = (b) => {
    block.push(b);
    if (block.length === 255) {
      out.push(255, ...block);
      block = [];
    }
  };
  let size = 9;
  const emit = (code) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      byte(acc & 255);
      acc >>>= 8;
      bits -= 8;
    }
  };
  const CLEAR = 256;
  const END = 257;
  // prefix code * 256 + next index -> code
  let table = new Map();
  let next = 258;
  emit(CLEAR);
  let prefix = px[0];
  for (let i = 1; i < px.length; i++) {
    const k = px[i];
    const key = prefix * 256 + k;
    const hit = table.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    if (next === 4096) {
      emit(CLEAR);
      table = new Map();
      next = 258;
      size = 9;
    } else {
      // a code may need one more bit only after it has been added
      if (next === 1 << size) size++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(END);
  if (bits > 0) byte(acc & 255);
  if (block.length) out.push(block.length, ...block);
  out.push(0);
  return Buffer.from(out);
}

/**
 * The GIF of `frames` (each BGRA, any size; the screen is the largest), looping forever. A frame gives its pixels as
 * `bgra` or as `load()`, called once while it is encoded, so a long recording needn't hold every bitmap at once.
 * @param {{ width: number, height: number, bgra?: Uint8Array, load?: () => Uint8Array, delayMs: number }[]} frames
 * @param {{ yieldEvery?: () => Promise<void> }} [o] yieldEvery: awaited between frames, so a long encode doesn't hold the process
 */
async function encodeGif(frames, { yieldEvery = () => new Promise((r) => setImmediate(r)) } = {}) {
  const w = Math.max(1, ...frames.map((f) => f.width));
  const h = Math.max(1, ...frames.map((f) => f.height));
  const u16 = (n) => [n & 255, (n >> 8) & 255];
  const parts = [
    Buffer.from('GIF89a'),
    Buffer.from([...u16(w), ...u16(h), 0xf7, 0, 0]),
    PALETTE,
    // NETSCAPE2.0: loop forever
    Buffer.from([0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0]),
  ];
  /** @type {{ box: { x: number, y: number, w: number, h: number }, px: Uint8Array, delay: number }[]} */
  const out = [];
  /** @type {Uint8Array | null} */
  let prev = null;
  for (const f of frames) {
    const cur = indices({ width: f.width, height: f.height, bgra: f.bgra ?? /** @type {() => Uint8Array} */ (f.load)() }, w, h);
    const box = prev ? changed(prev, cur, w, h) : { x: 0, y: 0, w, h };
    const delay = Math.max(2, Math.round(f.delayMs / 10));
    if (!box) {
      // nothing changed: the frame before shows longer
      out[out.length - 1].delay += delay;
      continue;
    }
    const px = new Uint8Array(box.w * box.h);
    for (let y = 0; y < box.h; y++) px.set(cur.subarray((box.y + y) * w + box.x, (box.y + y) * w + box.x + box.w), y * box.w);
    out.push({ box, px, delay });
    prev = cur;
    await yieldEvery();
  }
  for (const { box, px, delay } of out) {
    // graphic control: disposal 1 (leave in place), the delay in centiseconds (at most 65535)
    parts.push(Buffer.from([0x21, 0xf9, 4, 0x04, ...u16(Math.min(delay, 65535)), 0, 0]));
    parts.push(Buffer.from([0x2c, ...u16(box.x), ...u16(box.y), ...u16(box.w), ...u16(box.h), 0, 8]));
    parts.push(lzw(px));
    await yieldEvery();
  }
  parts.push(Buffer.from([0x3b]));
  return { gif: Buffer.concat(parts), width: w, height: h, frames: out.length };
}

module.exports = { encodeGif, lzw, PALETTE };
