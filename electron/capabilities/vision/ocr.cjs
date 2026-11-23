// The local OCR element list (the helper's ocr.elements, Vision framework) merged into the
// accessibility element list: text the accessibility tree doesn't name, as clickable elements.

const { prefixUnits } = require('../../../shared/textPrefix.mjs');

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** The OCR-read items of the helper's answer ([{ text, frame: {x, y, w, h}, source? }], screen points); its accessibility entries are left to the AX list. */
function ocrItems(res) {
  const list = Array.isArray(res) ? res : Array.isArray(res?.elements) ? res.elements : [];
  return list.filter(
    (e) => e && typeof e.text === 'string' && e.text.trim() && e.frame && e.frame.w > 0 && e.frame.h > 0 && e.source !== 'ax',
  );
}

const inside = (f, g) => f.x + f.w / 2 >= g.x && f.x + f.w / 2 <= g.x + g.w && f.y + f.h / 2 >= g.y && f.y + f.h / 2 <= g.y + g.h;

/**
 * Adds the OCR items the accessibility list doesn't already carry: one whose center falls inside an
 * element that already shows the same text is dropped. Returns the lines to append, and records the
 * new elements in `byId` as ocr-N so computer_click can use them.
 * @param {Map<string, any>} byId elements by id (frames in screen points)
 * @param {any} res the helper's ocr.elements result
 * @param {(p: {x: number, y: number}) => {x: number, y: number}} toView screen points to screenshot pixels
 */
function mergeOcr(byId, res, toView, max = 200) {
  const known = [...byId.values()].map((n) => ({
    frame: n.frame,
    text: norm([n.title, n.description, n.value].filter(Boolean).join(' ')),
  }));
  const lines = [];
  let n = 0;
  for (const it of ocrItems(res)) {
    const t = norm(it.text);
    if (known.some((k) => k.text && (k.text.includes(t) || t.includes(k.text)) && inside(it.frame, k.frame))) continue;
    const id = `ocr-${n++}`;
    byId.set(id, { id, role: 'AXStaticText', title: it.text, frame: it.frame });
    if (lines.length < max) {
      const c = toView({ x: it.frame.x + it.frame.w / 2, y: it.frame.y + it.frame.h / 2 });
      lines.push(`[${id}] Text "${prefixUnits(it.text.replace(/\s+/g, ' '), 100)}" at (${c.x}, ${c.y})`);
    }
  }
  return lines;
}

module.exports = { ocrItems, mergeOcr, norm, inside };
