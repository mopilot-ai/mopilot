// A draft in a component that shows or edits it: its text, and a setter that takes the new text or a function of the old one; only the components that call this re-render when the text changes.
import { useCallback, useSyncExternalStore } from 'react';
import type { DraftHandle } from './drafts';

export function useDraft(handle: DraftHandle): [string, (value: string | ((old: string) => string)) => void] {
  const text = useSyncExternalStore(handle.subscribe, handle.get);
  const set = useCallback(
    (value: string | ((old: string) => string)) => handle.set(typeof value === 'function' ? value(handle.get()) : value),
    [handle],
  );
  return [text, set];
}
