// A draft handle for a test: holds the text, calls back on every write, and tells subscribers, as the app's draft store does.
import type { DraftHandle } from '../../../mobile/src/presentation/drafts';

export function fakeDraft(
  text = '',
  on: { set?: (text: string) => void; clear?: (expected: string) => void } = {},
): DraftHandle & { text: () => string } {
  let held = text;
  const listeners = new Set<() => void>();
  let ticks = 0;
  const tell = () => listeners.forEach((l) => l());
  return {
    get: () => held,
    set(next) {
      held = next;
      on.set?.(next);
      tell();
    },
    clear(expected) {
      on.clear?.(expected);
      if (held === expected) {
        held = '';
        tell();
      }
    },
    focus() {
      ticks += 1;
      tell();
    },
    focusTick: () => ticks,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    text: () => held,
  };
}
