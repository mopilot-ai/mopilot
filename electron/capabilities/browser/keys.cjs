// Key chords and modifier names as CDP key events, for the browser host's keyboard input.
const { ToolError } = require('../contract/registry.cjs');

const MODIFIERS = { alt: 1, option: 1, ctrl: 2, control: 2, cmd: 4, command: 4, meta: 4, super: 4, win: 4, windows: 4, shift: 8 };
/** "ctrl+shift" -> CDP modifier bits. */
function modifierBits(spec) {
  let bits = 0;
  for (const part of String(spec || '')
    .toLowerCase()
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (!Object.hasOwn(MODIFIERS, part)) throw new ToolError(`Unknown modifier: ${part}`, 'bad_args');
    bits |= MODIFIERS[part];
  }
  return bits;
}

const NAMED_KEYS = {
  enter: ['Enter', 'Enter', 13, '\r'],
  return: ['Enter', 'Enter', 13, '\r'],
  tab: ['Tab', 'Tab', 9],
  escape: ['Escape', 'Escape', 27],
  esc: ['Escape', 'Escape', 27],
  backspace: ['Backspace', 'Backspace', 8],
  delete: ['Delete', 'Delete', 46],
  del: ['Delete', 'Delete', 46],
  space: [' ', 'Space', 32, ' '],
  insert: ['Insert', 'Insert', 45],
  arrowup: ['ArrowUp', 'ArrowUp', 38],
  up: ['ArrowUp', 'ArrowUp', 38],
  arrowdown: ['ArrowDown', 'ArrowDown', 40],
  down: ['ArrowDown', 'ArrowDown', 40],
  arrowleft: ['ArrowLeft', 'ArrowLeft', 37],
  left: ['ArrowLeft', 'ArrowLeft', 37],
  arrowright: ['ArrowRight', 'ArrowRight', 39],
  right: ['ArrowRight', 'ArrowRight', 39],
  home: ['Home', 'Home', 36],
  end: ['End', 'End', 35],
  pageup: ['PageUp', 'PageUp', 33],
  pagedown: ['PageDown', 'PageDown', 34],
  shift: ['Shift', 'ShiftLeft', 16],
  control: ['Control', 'ControlLeft', 17],
  ctrl: ['Control', 'ControlLeft', 17],
  alt: ['Alt', 'AltLeft', 18],
  meta: ['Meta', 'MetaLeft', 91],
  cmd: ['Meta', 'MetaLeft', 91],
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, [`F${i + 1}`, `F${i + 1}`, 112 + i]])),
};
const MAC_COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' };

/** One chord ("ctrl+a", "Enter", "A") as CDP key events. */
function chord(spec, platform = process.platform) {
  const parts = String(spec).split('+');
  const main = parts.pop() || '+';
  const mods = parts.length ? modifierBits(parts.join('+')) : 0;
  let def = Object.hasOwn(NAMED_KEYS, main.toLowerCase()) ? NAMED_KEYS[main.toLowerCase()] : undefined;
  if (!def) {
    if ([...main].length !== 1) throw new ToolError(`Unknown key: ${main}`, 'bad_args');
    const upper = main.toUpperCase();
    const code = /[a-z]/i.test(main) ? `Key${upper}` : /\d/.test(main) ? `Digit${main}` : '';
    const ch = mods & 8 && /[a-z]/.test(main) ? upper : main;
    def = [ch, code, /[a-z0-9]/i.test(main) ? upper.charCodeAt(0) : main.charCodeAt(0), ch];
  }
  const [key, code, vk, text] = def;
  const typed = text && !(mods & (2 | 4)) ? text : undefined;
  let commands;
  if (platform === 'darwin' && mods & 4) {
    const k = key.toLowerCase();
    if (k === 'z' && mods & 8) commands = ['redo'];
    else if (MAC_COMMANDS[k]) commands = [MAC_COMMANDS[k]];
  }
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods };
  return {
    down: {
      type: typed ? 'keyDown' : 'rawKeyDown',
      ...base,
      ...(typed ? { text: typed, unmodifiedText: typed } : {}),
      ...(commands ? { commands } : {}),
    },
    up: { type: 'keyUp', ...base },
  };
}

/** The modifier keys a chord names, as the order they go down in: "ctrl+shift+k" -> Control, then Shift. */
const MODIFIER_KEYS = { 1: NAMED_KEYS.alt, 2: NAMED_KEYS.control, 4: NAMED_KEYS.meta, 8: NAMED_KEYS.shift };

/**
 * One chord as the key events a keyboard sends: each modifier goes down (in the order named, its bit joining the
 * held set), then the key; then the key comes up and the modifiers after it, in reverse. A page that tracks which
 * keys are down sees them held while the key is pressed, as with a real keyboard.
 * @returns {{ downs: object[], ups: object[] }}
 */
function chordEvents(spec, platform = process.platform) {
  const main = chord(spec, platform);
  const parts = String(spec).split('+');
  parts.pop();
  const downs = [];
  const ups = [];
  let held = 0;
  for (const part of parts) {
    const bit = modifierBits(part);
    if (!bit || held & bit) continue;
    held |= bit;
    const [key, code, vk] = MODIFIER_KEYS[bit];
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    downs.push({ type: 'rawKeyDown', ...base, modifiers: held });
    ups.unshift({ type: 'keyUp', ...base, modifiers: held & ~bit });
  }
  return { downs: [...downs, main.down], ups: [main.up, ...ups] };
}

module.exports = { modifierBits, chord, chordEvents };
