// How big an in-app browser screenshot is (IAB-07), for every harness: the same model-aware limits as
// desktop screenshots (desktopPolicy.cjs: up to 2000 px on the long edge and about 3.75 MP for models
// with high-resolution vision, else 1568 px and about 1.15 MP), keyed off the chat's current model.
//
// - A screenshot never exceeds the viewport's CSS pixels: when it fits the model's limits its pixels are
//   the coordinate frame (1:1), and when it doesn't, the result says the factor (mapping below).
// - A zoom shows its region at up to device resolution, within the model's zoom side.
// - The JPEG stays under MAX_JPEG_BYTES: lower quality first, then a smaller image.
const { screenshotLimits, screenshotSize } = require('../contract/desktopPolicy.cjs');

const JPEG_QUALITY = 75;
/** Qualities tried in turn while the image is over the byte cap. */
const QUALITIES = [JPEG_QUALITY, 60, 45];
/** Shrinks (each to 70% a side) tried after the qualities, before the smallest is returned anyway. */
const SHRINKS = 3;
const MAX_JPEG_BYTES = 1_000_000;
/** A full-page capture is at most this wide (it may be long). */
const FULL_PAGE_WIDTH = 1280;

/** The `scale` argument (0.1 to 1, default 1). */
function scaleOf(scale) {
  return Math.max(0.1, Math.min(1, Number(scale) || 1));
}

/**
 * The image size for a capture of `box` (CSS pixels) for a chat on `model`: a screenshot at most the
 * viewport's CSS size, a zoom (`zoom`) at most the page's `dpr`; both within the model's limits, then
 * times `scale`.
 * @returns {{ width: number, height: number, highRes: boolean }}
 */
function captureSize(
  box,
  /** @type {{ model?: string | null, dpr?: number, zoom?: boolean, scale?: number }} */ {
    model = null,
    dpr = 1,
    zoom = false,
    scale = 1,
  } = {},
) {
  const lim = screenshotLimits(model);
  const size = zoom
    ? screenshotSize(box.w, box.h, Math.max(1, Number(dpr) || 1), lim.zoomSide, Infinity)
    : screenshotSize(box.w, box.h, 1, lim.maxSide, lim.maxPixels);
  const s = scaleOf(scale);
  return { width: Math.max(1, Math.round(size.width * s)), height: Math.max(1, Math.round(size.height * s)), highRes: lim.highRes };
}

/**
 * How a capture's image pixels map to the coordinate frame (CSS pixels of the full viewport):
 * frame = origin + pixel × k. `rect` is a zoom's region (null for the whole viewport).
 */
function mapping({ width, height, rect = null }, frame) {
  const box = rect || { x: 0, y: 0, width: frame.w, height: frame.h };
  return { kx: box.width / width, ky: box.height / height, x0: box.x, y0: box.y };
}

/**
 * `img` (a nativeImage) resized to `size` as base64 JPEG under `maxBytes`: quality 75, then lower, then
 * 70% a side at a time; the last try is returned whatever its size.
 * @returns {{ data: string, width: number, height: number, quality: number }}
 */
function encodeJpeg(img, size, maxBytes = MAX_JPEG_BYTES, round = 0) {
  const out = img.resize({ width: size.width, height: size.height, quality: 'good' });
  let buf;
  let quality;
  for (quality of QUALITIES) {
    buf = out.toJPEG(quality);
    if (buf.length <= maxBytes) break;
  }
  if (buf.length <= maxBytes || round >= SHRINKS) {
    const got = out.getSize();
    return { data: buf.toString('base64'), width: got.width, height: got.height, quality };
  }
  return encodeJpeg(
    img,
    { width: Math.max(1, Math.round(size.width * 0.7)), height: Math.max(1, Math.round(size.height * 0.7)) },
    maxBytes,
    round + 1,
  );
}

module.exports = { captureSize, mapping, encodeJpeg, scaleOf, JPEG_QUALITY, MAX_JPEG_BYTES, FULL_PAGE_WIDTH };
