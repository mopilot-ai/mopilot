// Desktop keyboard combo normalization, key sequences and reserved system-shortcut detection.

/* -- keys --------------------------------------------------------- */
const KEY_ALIASES = {
  enter: 'return',
  kp_enter: 'enter',
  esc: 'escape',
  page_up: 'pageup',
  page_down: 'pagedown',
  prior: 'pageup',
  next: 'pagedown',
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
  backspace: 'delete',
  del: 'forwarddelete',
  forward_delete: 'forwarddelete',
  super: 'cmd',
  win: 'cmd',
  meta: 'cmd',
  command: 'cmd',
  control: 'ctrl',
  option: 'alt',
  opt: 'alt',
  minus: '-',
  equal: '=',
  comma: ',',
  period: '.',
  slash: '/',
  semicolon: ';',
  apostrophe: "'",
  grave: '`',
  bracketleft: '[',
  bracketright: ']',
  backslash: '\\',
};

/** One combination as the helper names it: "ctrl+Page_Down" -> "ctrl+pagedown", "super+c" -> "cmd+c". */
function normalizeCombo(spec) {
  return String(spec)
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .map((p) => {
      if (Object.hasOwn(KEY_ALIASES, p)) return KEY_ALIASES[p];
      const normalized = p.replace(/-/g, '_');
      return Object.hasOwn(KEY_ALIASES, normalized) ? KEY_ALIASES[normalized] : p;
    })
    .join('+');
}

/** A key text may hold several combinations separated by spaces ("ctrl+a Delete"). */
function keySequence(text) {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeCombo);
}

const MODS = new Set(['cmd', 'ctrl', 'alt', 'shift', 'fn']);
const comboKey = (combo) => {
  const parts = combo.split('+');
  const key = parts.pop();
  return [...new Set(parts)].sort().join('+') + '|' + key;
};
/** Combinations that act on the whole Mac (quit, switch or hide apps, lock, log out, Spotlight, force quit). */
const SYSTEM_COMBOS = new Set(
  [
    'cmd+q',
    'cmd+shift+q',
    'cmd+alt+shift+q',
    'cmd+tab',
    'cmd+shift+tab',
    'cmd+`',
    'cmd+space',
    'ctrl+space',
    'ctrl+cmd+q',
    'cmd+alt+escape',
    'cmd+h',
    'cmd+alt+h',
    'cmd+alt+d',
    'ctrl+up',
    'ctrl+down',
    'ctrl+left',
    'ctrl+right',
    'cmd+alt+m',
    'ctrl+cmd+f',
    'cmd+shift+3',
    'cmd+shift+4',
    'cmd+shift+5',
  ].map(comboKey),
);
function isSystemCombo(combo) {
  const parts = combo.split('+');
  if (parts.length < 2 || !parts.slice(0, -1).every((m) => MODS.has(m))) return false;
  return SYSTEM_COMBOS.has(comboKey(combo));
}
const hasEscape = (combo) => combo.split('+').pop() === 'escape';

module.exports = { normalizeCombo, keySequence, isSystemCombo, hasEscape };
