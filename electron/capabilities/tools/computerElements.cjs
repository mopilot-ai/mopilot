// Computer-tool accessibility element listing, hit testing and screenshot coordinate conversion.
const { prefixUnits } = require('../../../shared/textPrefix.mjs');

const MAX_ELEMENTS = 300;
const INTERACTIVE = new Set([
  'AXButton',
  'AXCheckBox',
  'AXRadioButton',
  'AXPopUpButton',
  'AXMenuButton',
  'AXMenuItem',
  'AXMenuBarItem',
  'AXTextField',
  'AXTextArea',
  'AXSearchField',
  'AXComboBox',
  'AXLink',
  'AXSlider',
  'AXTab',
  'AXRow',
  'AXCell',
  'AXDisclosureTriangle',
  'AXIncrementor',
]);

const labelOf = (n) => [n.title, n.description, n.value].filter((s) => typeof s === 'string' && s.trim()).join(' · ');

/** Screen points <-> the pixels of the chat's last screenshot (identity before any screenshot). */
const IDENTITY = { x: 0, y: 0, ppp: 1 };
const toView = (g, p) => ({ x: Math.round((p.x - g.x) * g.ppp), y: Math.round((p.y - g.y) * g.ppp) });
const toPoints = (g, p) => ({ x: g.x + p.x / g.ppp, y: g.y + p.y / g.ppp });

/** @typedef {{ id: string, frame: { x: number, y: number, w: number, h: number }, [k: string]: any }} AXElement a helper element node */

/**
 * The element list as text, interactive or labelled elements only, with each one's center in the
 * screenshot's pixels. Returns the text and the elements by id (frames in screen points).
 */
function elementList(snap, geom = IDENTITY, max = MAX_ELEMENTS) {
  /** @type {Map<string, AXElement>} */
  const byId = new Map();
  const lines = [];
  const walk = (n, depth) => {
    if (!n || typeof n !== 'object') return;
    const label = labelOf(n);
    const role = typeof n.role === 'string' ? n.role : '';
    if (n.frame && (INTERACTIVE.has(role) || (label && role !== 'AXApplication')) && n.frame.w > 0 && n.frame.h > 0) {
      byId.set(n.id, n);
      if (lines.length < max) {
        const c = toView(geom, { x: n.frame.x + n.frame.w / 2, y: n.frame.y + n.frame.h / 2 });
        const flags = [n.focused ? 'focused' : '', n.enabled === false ? 'disabled' : ''].filter(Boolean).join(', ');
        lines.push(
          `[${n.id}] ${role.replace(/^AX/, '') || 'Element'}${label ? ` "${prefixUnits(label.replace(/\s+/g, ' '), 100)}"` : ''} at (${c.x}, ${c.y})${flags ? ` (${flags})` : ''}`,
        );
      }
    }
    for (const k of Array.isArray(n.children) ? n.children : []) walk(k, depth + 1);
  };
  walk(snap?.root, 0);
  const app = snap?.app?.name ? `${snap.app.name}: ` : '';
  const more = byId.size > lines.length ? `\n(${byId.size - lines.length} more not shown)` : '';
  const text = lines.length
    ? `${app}${lines.length} elements (id, role, label, center)\n${lines.join('\n')}${more}`
    : `${app}no elements found`;
  return { text, byId };
}

/**
 * The smallest known element whose frame holds the point (screen points).
 * @template {{ frame: { x: number, y: number, w: number, h: number } }} E
 * @param {Map<unknown, E>} byId
 * @param {{ x: number, y: number }} p
 * @returns {E | null}
 */
function elementAt(byId, p) {
  /** @type {E | null} */
  let best = null;
  for (const n of byId.values()) {
    const f = n.frame;
    if (p.x < f.x || p.y < f.y || p.x > f.x + f.w || p.y > f.y + f.h) continue;
    if (!best || f.w * f.h < best.frame.w * best.frame.h) best = n;
  }
  return best;
}

module.exports = { IDENTITY, elementList, elementAt, toView, toPoints };
