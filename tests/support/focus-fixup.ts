// Chromium's focus fixup in happy-dom, and keys pressed the way a person presses them: to whatever has the focus.
import { act } from 'react';

/** What Chromium lets keep the focus: an enabled form control, a link, a tabindex, an editor. */
function focusable(el: HTMLElement) {
  if ((el as HTMLInputElement).disabled) return false;
  if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName)) return true;
  if (el.tagName === 'A' && el.hasAttribute('href')) return true;
  return el.hasAttribute('tabindex') || el.isContentEditable;
}

/**
 * When the focused element stops being focusable (an editor turned contentEditable=false, a disabled input) or leaves
 * the document, Chromium moves the focus to <body>; happy-dom keeps it, which hid #1658 from every key test. Returns
 * the uninstaller.
 */
export function focusFixup(): () => void {
  const observer = new MutationObserver(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || (el.isConnected && focusable(el))) return;
    // happy-dom refuses to blur a disabled element: blur it as it was, then put the attribute back
    const field = el as HTMLInputElement;
    const disabled = field.disabled;
    field.disabled = false;
    el.blur();
    field.disabled = disabled;
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['contenteditable', 'disabled', 'tabindex'],
  });
  return () => observer.disconnect();
}

/** The element a key goes to: the focused one, or <body> when nothing has the focus. */
export const keyTarget = () => (document.activeElement as HTMLElement | null) ?? document.body;

/** A keydown to whatever has the focus, as CDP's Input.dispatchKeyEvent sends it. True when a handler took it. */
export async function pressKey(key: string, init: KeyboardEventInit = {}) {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => void keyTarget().dispatchEvent(ev));
  return ev.defaultPrevented;
}
