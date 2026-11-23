// Motion bench: decoded recording frames (bench/motion/decode.swift output) parsed into timed luma frames, cut to regions, and turned into per-frame change and profile signals.

/**
 * A region in the recording's source pixels: `[x, y, width, height]`.
 * @typedef {[number, number, number, number]} Rect
 * @typedef {{ t: number, px: Uint8Array }} Frame `t` in milliseconds from the recording's start
 * @typedef {{ width: number, height: number, scale: number, source: [number, number], frames: Frame[] }} Video
 * @typedef {{ t: number, d: number, n: number, m: number }} Sample one frame's change from the frame before: `d` the
 *   mean luma change (0–255); `n` the area that changed by more than PIXEL_DELTA, in source px²; `m` that area's
 *   mass, its luma change summed over it
 */

/** Parses decode.swift's output: a JSON header line, then per frame a float64 time in seconds and its luma bytes. */
export function parseFrames(/** @type {Buffer} */ buf) {
  const nl = buf.indexOf(10);
  if (nl < 0) throw new Error('not a frames file: no header line');
  const head = JSON.parse(buf.subarray(0, nl).toString('utf8'));
  for (const k of ['width', 'height', 'scale']) {
    if (!Number.isInteger(head[k]) || head[k] <= 0) throw new Error(`not a frames file: bad ${k}`);
  }
  const size = head.width * head.height;
  /** @type {Frame[]} */
  const frames = [];
  let at = nl + 1;
  for (; at + 8 + size <= buf.length; at += 8 + size) {
    frames.push({ t: buf.readDoubleLE(at) * 1000, px: new Uint8Array(buf.buffer, buf.byteOffset + at + 8, size) });
  }
  if (at !== buf.length) throw new Error(`frames file truncated: ${buf.length - at} bytes after frame ${frames.length}`);
  /** @type {Video} */
  const video = {
    width: head.width,
    height: head.height,
    scale: head.scale,
    source: Array.isArray(head.source) ? head.source : [head.width * head.scale, head.height * head.scale],
    frames,
  };
  return video;
}

/** A source-pixel rect in the decoded frame's cells, clamped to the frame; throws when nothing of it is left. */
export function cells(/** @type {Video} */ video, /** @type {Rect} */ rect) {
  const s = video.scale;
  const x0 = Math.max(0, Math.floor(rect[0] / s));
  const y0 = Math.max(0, Math.floor(rect[1] / s));
  const x1 = Math.min(video.width, Math.ceil((rect[0] + rect[2]) / s));
  const y1 = Math.min(video.height, Math.ceil((rect[1] + rect[3]) / s));
  if (x1 <= x0 || y1 <= y0) throw new Error(`region ${rect.join(',')} is outside the ${video.source.join('x')} recording`);
  return { x0, y0, x1, y1 };
}

/**
 * A cell changed when its luma moved by more than this. Video compression flips a few cells by 6–10 levels at each
 * keyframe; text and UI edges move by tens of levels.
 */
export const PIXEL_DELTA = 16;

/** How two frames differ over a region: the mean absolute luma difference, and the area (source px²) that moved past `delta` with its mass. */
export function diff(
  /** @type {Video} */ video,
  /** @type {Uint8Array} */ a,
  /** @type {Uint8Array} */ b,
  /** @type {Rect} */ rect,
  delta = PIXEL_DELTA,
) {
  const { x0, y0, x1, y1 } = cells(video, rect);
  let sum = 0;
  let n = 0;
  let m = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = y * video.width + x;
      const d = Math.abs(a[i] - b[i]);
      sum += d;
      if (d > delta) {
        n += 1;
        m += d;
      }
    }
  }
  const px = video.scale * video.scale;
  return { d: sum / ((x1 - x0) * (y1 - y0)), n: n * px, m: m * px };
}

/** Each frame's change from the frame before it over a region (the first frame's is none). */
export function changeSeries(/** @type {Video} */ video, /** @type {Rect} */ rect, delta = PIXEL_DELTA) {
  return video.frames.map((f, i) => ({ t: f.t, ...(i ? diff(video, video.frames[i - 1].px, f.px, rect, delta) : { d: 0, n: 0, m: 0 }) }));
}

/** The region's mean luma per column (`x`) or per row (`y`): what moves along that axis. */
export function profile(/** @type {Video} */ video, /** @type {Uint8Array} */ px, /** @type {Rect} */ rect, /** @type {'x' | 'y'} */ axis) {
  const { x0, y0, x1, y1 } = cells(video, rect);
  const along = axis === 'x' ? x1 - x0 : y1 - y0;
  const out = new Float64Array(along);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) out[axis === 'x' ? x - x0 : y - y0] += px[y * video.width + x];
  }
  const across = axis === 'x' ? y1 - y0 : x1 - x0;
  for (let k = 0; k < along; k += 1) out[k] /= across;
  return out;
}

/**
 * The shift, in cells, that best lines profile `a` up with profile `b` (`a[k] ≈ b[k + shift]`), up to `max` cells
 * either way, by the smallest mean absolute difference over the whole profile. Past either end `b` reads as its edge
 * value, so content shifted out of view counts against a shift instead of leaving two flat stretches to match. Ties go
 * to the smaller shift.
 */
export function bestShift(/** @type {Float64Array} */ a, /** @type {Float64Array} */ b, max = a.length - 1) {
  let best = 0;
  let bestErr = Number.POSITIVE_INFINITY;
  const last = b.length - 1;
  for (let s = 0; s <= Math.min(max, last); s += 1) {
    for (const shift of s ? [s, -s] : [0]) {
      let err = 0;
      for (let k = 0; k < a.length; k += 1) err += Math.abs(a[k] - b[Math.min(last, Math.max(0, k + shift))]);
      if (err < bestErr - 1e-9) {
        bestErr = err;
        best = shift;
      }
    }
  }
  return best;
}
