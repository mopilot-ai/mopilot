// Targeted text delivery tracks the exact React commit that accepted it, even if saving then retires the composer.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { focusComposer, receiveComposerText } from '../../lib/composerEvents';
import { withQueued } from '../../lib/queued';
import type { Attachment } from '../../store/types';
import { useStore } from '../../store/core';
import { isFocusedPane } from '../../store/split';

type Receipt = { threadId: string | null; committed: boolean };
export function useComposerText(
  threadId: string | null,
  inPane: boolean,
  setText: Dispatch<SetStateAction<string>>,
  setAttachments: Dispatch<SetStateAction<Attachment[]>>,
  input: RefObject<{ focus(): void } | null>,
) {
  // the focused pane's composer: untargeted commands, inserts and shortcuts reach it alone
  const main = useStore((s) => !inPane && isFocusedPane(s, threadId));
  // a side chat's composer takes the keyboard as it opens; a pane's only while it is the focused one
  const focusable = useRef(false);
  focusable.current = inPane || main;
  const takesFocus = useCallback(() => focusable.current, []);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  useLayoutEffect(() => {
    if (receipt && receipt.threadId === threadId) receipt.committed = true;
  }, [receipt, threadId]);
  useEffect(() => {
    const focus = (event: Event) => focusComposer(event, threadId, main, () => input.current?.focus());
    const insert = (event: Event) =>
      receiveComposerText(event, threadId, main, (text, more, prepend) => {
        const next = { threadId, committed: false };
        setReceipt(next);
        setText((before) =>
          prepend
            ? withQueued(before, [], { text, attachments: [] }).text
            : (before ? before + (before.endsWith('\n') ? '' : '\n') : '') + text,
        );
        if (more.length) setAttachments((before) => (prepend ? [...more, ...before] : [...before, ...more]));
        input.current?.focus();
        return next;
      });
    window.addEventListener('focus-composer', focus);
    window.addEventListener('composer-insert', insert);
    return () => {
      window.removeEventListener('focus-composer', focus);
      window.removeEventListener('composer-insert', insert);
    };
  }, [threadId, main, setText, setAttachments, input]);
  return { main, takesFocus };
}
