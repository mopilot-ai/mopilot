// ↑/↓ through the chat's earlier prompts in the composer, and the "History n/N" position shown while one is recalled.

import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useStore } from '../../store/core';
import { promptHistory } from '../../lib/promptHistory';

interface Browse {
  chatId: string | null;
  list: string[];
  idx: number;
}

/**
 * ↑ in an empty box recalls the last prompt and keeps stepping back while the recalled one is untouched; ↓ steps
 * forward and past the newest clears the box. Editing the recalled text, or another chat, ends the browse.
 */
export function useComposerHistory(chatId: string | null, text: string, setText: (value: string) => void) {
  const [browse, setBrowse] = useState<Browse | null>(null);
  const active = browse && browse.chatId === chatId && text === browse.list[browse.idx] ? browse : null;

  const go = (b: Browse, idx: number) => {
    if (idx >= b.list.length) {
      setBrowse(null);
      setText('');
      return;
    }
    setBrowse({ ...b, idx });
    setText(b.list[idx]);
  };

  /** Handles an arrow key for the history; false when the key is the caret's. */
  const onKey = (e: KeyboardEvent, empty: boolean): boolean => {
    if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false;
    if (e.key === 'ArrowUp' && (active || empty)) {
      const b = active ?? {
        chatId,
        list: promptHistory(chatId, chatId ? useStore.getState().runtime[chatId]?.turns : undefined),
        idx: Number.POSITIVE_INFINITY,
      };
      const idx = Math.min(b.idx, b.list.length) - 1;
      if (idx < 0) return false;
      e.preventDefault();
      go(b, idx);
      return true;
    }
    if (e.key === 'ArrowDown' && active) {
      e.preventDefault();
      go(active, active.idx + 1);
      return true;
    }
    return false;
  };

  return { onKey, position: active ? { n: active.idx + 1, total: active.list.length } : null };
}
