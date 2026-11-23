// What the agent cursor (agentCursor.cjs) shows for one browser action: the label beside the pointer and the overlay's arguments, never the typed text.

const { prefixUnits } = require('../../../shared/textPrefix.mjs');

const quote = (s, n = 40) => {
  const t = String(s ?? '')
    .replace(/[\u0000-\u001f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${prefixUnits(t, n - 1)}…` : t;
};

/** The label beside the pointer for an action BrowserTabs reports. */
function labelFor(a) {
  const named = (verb) => (a.name ? `${verb} “${quote(a.name)}”` : verb);
  switch (a.kind) {
    case 'click': {
      const verb =
        a.button === 'right'
          ? 'Right-clicking'
          : a.button === 'middle'
            ? 'Middle-clicking'
            : a.clickCount === 2
              ? 'Double-clicking'
              : a.clickCount >= 3
                ? 'Triple-clicking'
                : 'Clicking';
      return named(verb);
    }
    case 'hover':
      return named('Pointing at');
    case 'drag':
      return 'Dragging';
    case 'scroll':
      return `Scrolling ${a.direction || 'down'}`;
    case 'type':
      return 'Typing';
    case 'key':
      return `Pressing ${quote(a.keys, 30)}`;
    default:
      return '';
  }
}

/** What the overlay draws for an action. */
function overlayArgs(a) {
  const out = { label: labelFor(a) };
  if (Number.isFinite(a.x) && Number.isFinite(a.y)) Object.assign(out, { x: a.x, y: a.y });
  if (a.kind === 'click') out.click = true;
  if (a.kind === 'type' || a.kind === 'key') out.focus = true;
  if (a.kind === 'drag' && a.to && Number.isFinite(a.to.x) && Number.isFinite(a.to.y)) out.to = { x: a.to.x, y: a.to.y };
  return out;
}

module.exports = { labelFor, overlayArgs };
