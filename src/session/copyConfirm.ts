// The confirmation a copy button shows on itself: one check per click, held then faded out, never a stale one.
import { useEffect, useRef, useState } from 'react';
import { copyText } from './clipboard';

/**
 * How long a copied check stays before it is gone. The check fades out over the tail of it rather than
 * snapping away: `.copy-check` in src/styles/app/motion.css animates for exactly this long, and
 * tests/copyConfirm.test.ts keeps the two the same length.
 */
export const COPY_CHECK_MS = 2500;

/**
 * A copy button's own confirmation, shared by every button that shows one instead of a toast.
 *
 * `copy(text)` writes `text` and, once it is on the clipboard, sets `copied` to `key` (the text itself by
 * default) for COPY_CHECK_MS. `key` is what a control with several copy buttons compares against to know
 * which one to check; `copied === key` is the check's condition.
 *
 * Only the latest click can confirm: a click retires the ones before it, so an earlier write settling late
 * -- resolved or rejected -- neither checks a button the user has moved on from nor clears the newer check.
 * A write that fails shows no check and takes back an earlier one (src/session/clipboard.ts says why it failed).
 * Unmounting retires the pending click too, so the hold timer never outlives the button that started it.
 */
export function useCopyConfirm(): { copied: string | null; copy: (text: string, key?: string) => void } {
  const [copied, setCopied] = useState<string | null>(null);
  const run = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      run.current++;
      clearTimeout(timer.current);
    },
    [],
  );
  const copy = (text: string, key = text) => {
    const mine = ++run.current;
    const settle = (shown: string | null) => {
      if (mine !== run.current) return;
      clearTimeout(timer.current);
      setCopied(shown);
      if (shown !== null) timer.current = setTimeout(() => settle(null), COPY_CHECK_MS);
    };
    copyText(
      text,
      () => settle(key),
      () => settle(null),
    );
  };
  return { copied, copy };
}
