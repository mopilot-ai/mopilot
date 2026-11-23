// Synthetic decoded recordings for the motion bench tests: bench/motion/synth.swift's timeline drawn straight into luma frames, plus tiny hand-made videos and their decode.swift byte form.
import { bezierAt } from '../../bench/lib/motion/fit.mjs';

export type Video = { width: number; height: number; scale: number; source: [number, number]; frames: { t: number; px: Uint8Array }[] };

/** A video whose frames are drawn by `draw(t, fill)` on a `w`×`h` canvas, block-averaged by `scale`; `skip` drops frame indexes. */
export function drawVideo(
  w: number,
  h: number,
  scale: number,
  count: number,
  draw: (t: number, fill: (x: number, y: number, fw: number, fh: number, v: number) => void) => void,
  { fps = 60, skip = [] as number[] } = {},
): Video {
  const frames: Video['frames'] = [];
  const full = new Uint8Array(w * h);
  for (let i = 0; i < count; i += 1) {
    if (skip.includes(i)) continue;
    const t = (i / fps) * 1000;
    full.fill(32);
    draw(t / 1000, (x0, y0, fw, fh, v) => {
      for (let y = Math.max(0, y0); y < Math.min(h, y0 + fh); y += 1)
        for (let x = Math.max(0, x0); x < Math.min(w, x0 + fw); x += 1) full[y * w + x] = v;
    });
    const ow = w / scale;
    const oh = h / scale;
    const px = new Uint8Array(ow * oh);
    for (let y = 0; y < oh; y += 1)
      for (let x = 0; x < ow; x += 1) {
        let sum = 0;
        for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) sum += full[(y * scale + dy) * w + x * scale + dx];
        px[y * ow + x] = Math.floor(sum / (scale * scale));
      }
    frames.push({ t, px });
  }
  return { width: w / scale, height: h / scale, scale, source: [w, h], frames };
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** bench/motion/synth.swift's timeline (keep the two in step), 640x400, frames 70 and 71 dropped. */
export function synthVideo(scale = 4): Video {
  return drawVideo(
    640,
    400,
    scale,
    270,
    (t, fill) => {
      if (t >= 0.5) fill(20, 20, 80, 40, 230);
      fill(20, 110, 200, 60, Math.floor(32 + 198 * bezierAt([0, 0, 0.2, 1], clamp((t - 0.6) / 0.2))));
      fill(40 + Math.round(300 * bezierAt([0.32, 0.72, 0, 1], clamp((t - 1.0) / 0.3))), 205, 100, 50, 230);
      const words = t < 1.5 ? 0 : Math.min(10, Math.floor((t - 1.5) / 0.1 + 1e-9) + 1);
      for (let k = 0; k < words; k += 1) fill(20 + k * 50, 285, 40, 30, 200);
      fill(20, t >= 4.0 ? 360 : 340, 400, 20, 180);
    },
    { skip: [70, 71] },
  );
}

/** A video in decode.swift's byte form: a JSON header line, then per frame a float64 time in seconds and its luma. */
export function framesBuffer(video: Video, header: Record<string, unknown> = {}): Buffer {
  const head = Buffer.from(
    `${JSON.stringify({ width: video.width, height: video.height, scale: video.scale, source: video.source, ...header })}\n`,
  );
  const parts = [head];
  for (const f of video.frames) {
    const t = Buffer.alloc(8);
    t.writeDoubleLE(f.t / 1000, 0);
    parts.push(t, Buffer.from(f.px));
  }
  return Buffer.concat(parts);
}
