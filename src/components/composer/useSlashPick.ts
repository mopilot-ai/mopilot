// Applies a slash pick in the current draft and restores input when a picked action fails.

import type { RefObject } from 'react';
import { applyComposerSlashItem, type ComposerPopup, type ComposerSlashItem } from '../../lib/composerSkills';
import { setDraft, toast, get as getState } from '../../store/core';
import { errorText } from '../../lib/ignored';
import type { Attachment } from '../../store/types';
import type { ComposerInputElement } from './ComposerInput';

export function useSlashPick(o: {
  draftKey: string;
  text: string;
  attachments: Attachment[];
  setText: (value: string) => void;
  closePopup: () => void;
  input: RefObject<ComposerInputElement | null>;
  /** the draft the box shows now, and its attachments: a pick that fails gives back only what it left there */
  currentKey: RefObject<string>;
  currentOptions: RefObject<{ attachments: Attachment[] }>;
}) {
  const { draftKey, text, attachments, input } = o;

  const runPopupCommand = async (run: () => unknown, expectedText: string) => {
    // put back what was typed before the pick, as long as the box shows only what the pick left
    const restore = () => {
      if (o.currentKey.current === draftKey && input.current) {
        const currentText = input.current.value;
        if ((currentText !== expectedText && currentText !== text) || o.currentOptions.current.attachments !== attachments) return;
        o.setText(text);
      } else {
        const saved = getState().drafts[draftKey];
        if (saved && saved.text === expectedText && saved.attachments === attachments) setDraft(draftKey, { ...saved, text });
      }
    };
    try {
      // false: a send main didn't take (it said why)
      if ((await run()) === false) restore();
    } catch (e) {
      toast(errorText(e), 'error');
      restore();
    }
  };

  const pick = (popup: ComposerPopup, item: ComposerSlashItem) => {
    let expectedText = text;
    applyComposerSlashItem(
      text,
      popup,
      { ...item, run: () => runPopupCommand(() => item.run?.(), expectedText) },
      {
        setText: (value) => {
          expectedText = value;
          o.setText(value);
        },
        close: o.closePopup,
        focus: () => input.current?.focus(),
        restoreCaret: (pos) => {
          input.current?.focus();
          input.current?.setCaretAfter(expectedText, pos);
        },
      },
    );
  };

  return { runPopupCommand, pick };
}
