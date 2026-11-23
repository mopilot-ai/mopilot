// Focus and keyboard helpers for text fields: whether another field has the keyboard, select-on-focus that yields to typing, busy fields.
type El = { tagName: string; isContentEditable?: boolean };

/** Events that mean the user acted in a field: typing, a key (Home, an arrow) or the start of an IME composition. */
const INTERACTIONS = ['input', 'keydown', 'compositionstart'] as const;

/**
 * Run `fn` on the next frame unless the user acts in `el` first. Chromium runs a frame late in a window the OS has not
 * painted, so a caret or selection placed then would land under what the user already typed (#3148).
 */
export function onFrameUnlessTyped(el: HTMLElement | null, fn: () => void) {
  let acted = false;
  const mark = () => {
    acted = true;
  };
  // no field yet: nothing can be typed in it before the frame
  for (const type of INTERACTIONS) el?.addEventListener(type, mark);
  requestAnimationFrame(() => {
    for (const type of INTERACTIONS) el?.removeEventListener(type, mark);
    if (!acted) fn();
  });
}

/** Select a field's whole text on the next frame, as on taking focus, unless the user acts in it first. */
export const selectUnlessTyped = (el: HTMLInputElement) => onFrameUnlessTyped(el, () => el.select());

export function typingElsewhere(own: El, active: El | null = typeof document === 'undefined' ? null : document.activeElement) {
  if (!active || active === own) return false;
  return active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || !!active.isContentEditable;
}

/**
 * Props for a text field that takes no edits while its work runs (a send, a save, a rename): read-only rather than
 * disabled, so it keeps the keyboard. Chromium moves a disabled field's focus to <body> and nothing gives it back, so
 * the next key (Esc, the next message) would go nowhere (#1658; lint/rules/focus-drop.grit).
 */
export const busyField = (busy: boolean) => ({ readOnly: busy, 'aria-disabled': busy || undefined });

type KeyEv = {
  key: string;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
  isComposing?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};
/**
 * A key the input method is using (Japanese, Chinese…): Enter confirms a candidate and Escape cancels it, so neither
 * is the app's. Every Enter or Escape handler checks it first (tests/imeKeys.test.ts).
 */
export const imeComposing = (e: KeyEv) => !!(e.nativeEvent?.isComposing ?? e.isComposing) || e.keyCode === 229;

/** Enter that is the user's, not an input method confirming a candidate. */
export const isEnter = (e: KeyEv) => e.key === 'Enter' && !imeComposing(e);

/**
 * Escape in a field that cancels its edit (a rename, a search, a typed address): runs `cancel` and handles the key, so
 * the app's own Escape (src/session/appShortcuts.ts), which closes the side pane, leaves it alone. False for other keys, for
 * Escape ending an input method's composition, and with a modifier (Shift+Escape can be a shortcut).
 */
export function cancelOnEscape(e: KeyEv & { preventDefault(): void }, cancel: () => void): boolean {
  if (e.key !== 'Escape' || imeComposing(e) || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
  e.preventDefault();
  cancel();
  return true;
}

type ActivationEv = KeyEv & {
  repeat?: boolean;
  defaultPrevented?: boolean;
  target: unknown;
  currentTarget: unknown;
  preventDefault(): void;
};
/**
 * Keyboard activation for a clickable element that cannot be a <button> (a row holding its own buttons): Enter or
 * Space on the element itself runs `run`, as a click would. Keys pressed on a control inside it are left to that
 * control, and Enter that confirms an input method's candidate is not activation.
 */
export function onActivate(run: () => void) {
  return (e: ActivationEv) => {
    if (e.target !== e.currentTarget || e.repeat || e.defaultPrevented) return;
    const space = e.key === ' ' && !imeComposing(e);
    if (!isEnter(e) && !space) return;
    e.preventDefault();
    run();
  };
}

/** What a key does in a menu or listbox (WAI-ARIA, the active row shown with aria-activedescendant). */
export type ListMove = 'next' | 'prev' | 'first' | 'last' | 'pick' | 'open' | 'back';
/**
 * The move a key makes in a menu or listbox, or null for a key it leaves alone. `text`: a text field (the search
 * box that filters the list) has the keys, so Space, Home, End and the side arrows keep editing it. Keys that
 * confirm an input method's candidate, a held Enter or Space, and keys with a modifier (Shift+Arrow selects text,
 * Alt+Arrow and Cmd+Enter are app shortcuts) move nothing.
 */
export function listKey(e: KeyEv & { repeat?: boolean }, text = false): ListMove | null {
  if (imeComposing(e)) return null;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (e.key === 'ArrowDown') return 'next';
  if (e.key === 'ArrowUp') return 'prev';
  if (e.key === 'Enter') return e.repeat ? null : 'pick';
  if (text) return null;
  if (e.key === ' ') return e.repeat ? null : 'pick';
  if (e.key === 'Home') return 'first';
  if (e.key === 'End') return 'last';
  if (e.key === 'ArrowRight') return 'open';
  if (e.key === 'ArrowLeft') return 'back';
  return null;
}

/**
 * The row a move lands on among `count` rows, from `index` (-1: none is active yet, so Down starts at the first
 * and Up at the last). Menus wrap around; a filtered list (`wrap` false) stops at its ends.
 */
export function stepIndex(move: 'next' | 'prev' | 'first' | 'last', index: number, count: number, wrap = true): number {
  if (move === 'first') return 0;
  if (move === 'last') return count - 1;
  if (index < 0) return move === 'next' ? 0 : count - 1;
  const next = index + (move === 'next' ? 1 : -1);
  if (wrap) return (next + count) % count;
  return Math.max(0, Math.min(count - 1, next));
}
