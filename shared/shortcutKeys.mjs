// Physical key normalization and Electron accelerator encoding for every shortcut entrypoint.
import { ownTable } from './ownTable.mjs';
/** Keys whose character changes with Shift (⇧; would read ':'), named by their physical key. */
const CODE_KEYS = ownTable({
  NumpadAdd: 'NumpadAdd',
  NumpadSubtract: 'NumpadSubtract',
  Numpad0: 'Numpad0',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: ' ',
});

/** A key press as a shortcut combo: modifiers ⌃⌥⇧⌘ then the key, e.g. '⇧⌘;'. Null for a lone modifier. */
/** @param {{key: string, code: string, ctrlKey: boolean, altKey: boolean, shiftKey: boolean, metaKey: boolean}} e */
export function comboFromEvent(e, mac = true) {
  if (['Meta', 'Shift', 'Alt', 'Control'].includes(e.key)) return null;
  const k = e.code.startsWith('Key')
    ? e.code.slice(3)
    : e.code.startsWith('Digit')
      ? e.code.slice(5)
      : (CODE_KEYS[e.code] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key));
  // off macOS Ctrl takes ⌘'s place, so the default bindings (written ⌘…) work there too
  if (!mac) return `${e.altKey ? '⌥' : ''}${e.shiftKey ? '⇧' : ''}${e.ctrlKey ? '⌘' : ''}${e.metaKey ? '◆' : ''}${k}`;
  return `${e.ctrlKey ? '⌃' : ''}${e.altKey ? '⌥' : ''}${e.shiftKey ? '⇧' : ''}${e.metaKey ? '⌘' : ''}${k}`;
}

const MODS = { '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift', '⌘': 'CmdOrCtrl', '◆': 'Super' };
const NAMED = ownTable({
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  Numpad0: 'num0',
  ' ': 'Space',
  '+': 'Plus',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Escape',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
});

/** Electron accelerator for a combo, or null when Electron can't express its key. */
/** @param {string | null | undefined} combo */
export function toAccelerator(combo) {
  if (!combo) return null;
  const mods = [];
  let i = 0;
  while (i < combo.length && MODS[combo[i]]) mods.push(MODS[combo[i++]]);
  const key = combo.slice(i);
  if (!key) return null;
  // Plain editing keys must reach the focused control; the renderer can bind them outside text fields.
  if (!mods.some((m) => m !== 'Shift') && !/^F([1-9]|1\d|2[0-4])$/.test(key) && !(key === 'Escape' && mods.includes('Shift'))) return null;
  let k = NAMED[key];
  if (!k && /^F([1-9]|1\d|2[0-4])$/.test(key)) k = key;
  if (!k && /^[A-Z0-9]$/.test(key)) k = key;
  if (!k && /^[`\-=[\]\\;',./~!@#$%^&*()_{}|:"<>?]$/.test(key)) k = key;
  return k ? [...mods, k].join('+') : null;
}

/** Native editing combinations retain their text-control semantics even for legacy overrides. */
export function isEditingShortcut(combo, platform = 'darwin') {
  return ['⌘Z', '⇧⌘Z', '⌘X', '⌘C', '⌘V', '⇧⌘V', '⌘A', ...(platform === 'darwin' ? ['⌥⇧⌘V'] : ['⌘Y'])].includes(combo);
}
/** Keys that main can intercept without knowing the editable node inside a browser page. */
export function nativeShortcutAccelerator(combo, platform = 'darwin') {
  return isEditingShortcut(combo, platform) ? null : toAccelerator(combo);
}
