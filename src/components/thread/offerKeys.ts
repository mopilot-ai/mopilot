// The keys that answer a waiting offer card, as Claude Desktop's offer card takes them: ⌘/Ctrl+Enter for "New session"
// and Escape for "Do it here", only while the card is on screen and after a short grace, so a key meant for the
// composer the moment the card appeared isn't taken as an answer.
import { useEffect, useRef, type RefObject } from 'react';

/** How long after the card can answer before its keys do (Claude Desktop's armGraceMs). */
export const ARM_MS = 400;

/** Which answer a key press is, or null. */
export function offerKey(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'isComposing'>): 'start' | 'here' | null {
  if (e.isComposing) return null;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return 'start';
  if (e.key === 'Escape') return 'here';
  return null;
}

/** Answer the offer from the keyboard while `enabled` and the card (`ref`) is on screen. */
export function useOfferKeys(ref: RefObject<HTMLElement | null>, enabled: boolean, answer: (a: 'start' | 'here') => void) {
  const latest = useRef(answer);
  latest.current = answer;
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let shown = false;
    let armed = false;
    const timer = setTimeout(() => (armed = true), ARM_MS);
    const seen = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([e]) => (shown = !!e?.isIntersecting)) : null;
    if (seen) seen.observe(el);
    else shown = true;
    const onKey = (e: KeyboardEvent) => {
      // An option or composer popup owns its Escape and Enter before the offer card does.
      if (document.querySelector('.popover-layer, .tooltip.interactive')) return;
      // so does a text field of its own (find in the chat, an inline rename): only the composer's keys answer the card
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('input, textarea, [contenteditable="true"]') && !target.closest('[data-composer-chat]')) return;
      const a = offerKey(e);
      if (!a || !armed || !shown) return;
      // the card's answer, not the composer's Escape or send
      e.preventDefault();
      e.stopPropagation();
      latest.current(a);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(timer);
      seen?.disconnect();
      window.removeEventListener('keydown', onKey, true);
    };
  }, [ref, enabled]);
}
