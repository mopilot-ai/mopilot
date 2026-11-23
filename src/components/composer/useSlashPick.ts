// The composer's "/" picks: an entry runs on the draft its /name leaves, a command line it writes keeps that draft.

import { useRef, type RefObject } from 'react';
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
  // the draft a / pick leaves while its entry runs: a command line the entry writes goes in front of it
  const rest = useRef('');

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

  /**
   * A / pick's text, with the caret at `caret` (its end) in the same step: a key typed right after follows it (#1719).
   * Focusing again on the next frame keeps the keyboard here when the pick came from a menu that closes after it.
   */
  const putText = (value: string, caret = value.length) => {
    o.setText(value);
    input.current?.focus();
    input.current?.setCaretAfter(value, caret);
    requestAnimationFrame(() => input.current?.focus());
  };
  /** A command line a / pick writes: what the draft held besides the command follows it as its text, the caret after the command. */
  const putCommand = (line: string) => putText(line + rest.current, line.length);

  const pick = (popup: ComposerPopup, item: ComposerSlashItem) => {
    let expectedText = text;
    applyComposerSlashItem(
      text,
      popup,
      { ...item, run: () => runPopupCommand(() => item.run?.(), expectedText) },
      {
        setText: (value) => {
          expectedText = value;
          rest.current = value;
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
    rest.current = '';
  };

  return { runPopupCommand, putCommand, pick };
}
