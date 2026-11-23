// Marks on a sparse window screenshot (#3571 G7): when a window's accessibility list has too few elements to act on
// (Electron or canvas apps), the helper's app.marks draws on the same capture (the helper holds it from app.screenshot), reads its text with OCR and draws numbered boxes
// on the lines no listed element covers, numbered after the list; those lines join the window's elements, so
// element_index clicks them like any other element (at their center: they have no accessibility id).
const { noteIgnored } = require('../../ignored.cjs');
const P = require('../contract/desktopPolicy.cjs');
const { CONTAINERS } = require('./appScopedUtil.cjs');

/** Fewer actionable elements than this, and the screenshot gets marks. */
const SPARSE = 8;
/** The most marks one screenshot gets. */
const MAX_MARKS = 60;

/** Whether a window's element list is too sparse to act on. */
const sparse = (/** @type {{ role: string }[]} */ elements) => elements.filter((e) => !CONTAINERS.has(e.role)).length < SPARSE;

/**
 * The helper's marks as window elements: numbered as drawn, framed in global points, centered in frame pixels.
 * @param {any[]} marks @param {{ x: number, y: number, ppp: number, width: number, height: number }} geom
 */
function markElements(marks, geom) {
  return marks
    .filter((m) => Number.isInteger(m?.n) && typeof m.text === 'string' && m.frame && m.frame.w > 0 && m.frame.h > 0)
    .map((m) => ({
      index: m.n,
      role: 'OCRText',
      label: m.text,
      name: m.text,
      frame: m.frame,
      center: P.toPixels(geom, { x: m.frame.x + m.frame.w / 2, y: m.frame.y + m.frame.h / 2 }),
      enabled: true,
      focused: false,
      secure: false,
      actions: [],
      source: 'ocr',
    }));
}

/**
 * Asks the helper for marks on a sparse window: the marked image and the new elements, or null (not sparse, nothing
 * found, or a helper that can't: the screenshot stands as it is).
 * @param {any} helper @param {object} base the request's pid and bundle ids
 * @param {{ windowId: number, elements: any[], geom: any, maxSide: number, maxPixels?: number, scale: number }} o
 */
async function requestMarks(helper, base, o) {
  if (!sparse(o.elements)) return null;
  const taken = o.elements.filter((e) => !CONTAINERS.has(e.role)).map((e) => [e.frame.x, e.frame.y, e.frame.w, e.frame.h]);
  const start = o.elements.length + 1;
  const r = await helper
    .call(
      'app.marks',
      {
        ...base,
        windowId: o.windowId,
        start,
        taken,
        maxSide: o.maxSide,
        maxPixels: o.maxPixels,
        scale: o.scale,
        quality: 0.75,
        limit: MAX_MARKS,
        // draw on the pixels of the app.screenshot just made: one capture, and the marks sit on what its list was read beside
        reuse: true,
      },
      { timeoutMs: 60000 },
    )
    .catch((error) => {
      noteIgnored('draw marks on a sparse window', error);
      return null;
    });
  // element_index is a position in the window's list: only marks numbered on from it without a gap join it
  const all = markElements(Array.isArray(r?.marks) ? r.marks : [], o.geom);
  const gap = all.findIndex((e, i) => e.index !== start + i);
  const elements = gap < 0 ? all : all.slice(0, gap);
  if (!elements.length || typeof r.jpeg !== 'string') return null;
  return { image: { type: 'image', data: r.jpeg, mimeType: r.mimeType || 'image/jpeg' }, elements };
}

module.exports = { SPARSE, MAX_MARKS, sparse, markElements, requestMarks };
