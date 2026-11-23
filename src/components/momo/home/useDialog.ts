// What a dialog needs to be reachable from the keyboard: focus moves into it when it opens (to `[data-autofocus]`, else its first control), Tab stays inside it, Escape closes it, and focus goes back to where it came from.
import { useEffect, type RefObject } from 'react';
import { imeComposing } from '../../../lib/focus';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialog(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const el = ref.current as HTMLElement;
    const from = document.activeElement as HTMLElement | null;
    const items = () => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
    (el.querySelector<HTMLElement>('[data-autofocus]') ?? items()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Escape from an input method closes its candidate list, not this dialog
      if (e.key === 'Escape' && !imeComposing(e)) {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab') {
        const all = items();
        const first = all[0] as HTMLElement;
        const last = all[all.length - 1] as HTMLElement;
        const at = document.activeElement;
        if (e.shiftKey && at === first) e.preventDefault(), last.focus();
        else if (!e.shiftKey && at === last) e.preventDefault(), first.focus();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('keydown', onKey);
      from?.focus?.();
    };
  }, [ref, onClose]);
}
