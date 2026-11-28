// Applies a slash pick in the current draft and restores input when a picked action fails.

import { useCallback, type RefObject, type SetStateAction } from 'react';
import {
  applyComposerSlashItem,
  withSkillReference,
  type ComposerPopup,
  type ComposerSlashItem,
  type SkillReference,
} from '../../lib/composerSkills';
import { setDraft, toast, get as getState } from '../../store/core';
import { errorText } from '../../lib/ignored';
import type { Attachment } from '../../store/types';
import type { ComposerInputElement } from './ComposerInput';

export function useSlashPick(o: {
  draftKey: string;
  text: string;
  attachments: Attachment[];
  setText: (value: string) => void;
  setIncoming: (value: SetStateAction<Attachment[]>) => boolean;
  closePopup: () => void;
  input: RefObject<ComposerInputElement | null>;
  /** the draft the box shows now, and its attachments: a pick that fails gives back only what it left there */
  currentKey: RefObject<string>;
  currentOptions: RefObject<{ attachments: Attachment[] }>;
}) {
  const { draftKey, text, attachments, input, setText, setIncoming } = o;

  const insertSkill = useCallback(
    (skill: SkillReference, start?: number, end?: number) => {
      const editor = input.current;
      if (!editor) return;
      const value = editor.value;
      const from = start ?? value.length;
      const to = end ?? from;
      const attachment: Attachment = { kind: 'skill', ...skill, textOffset: from };
      if (!setIncoming((before) => withSkillReference(before, attachment, from, to))) return;
      if (from !== to) setText(value.slice(0, from) + value.slice(to));
      editor.setCaretAfterSkill(attachment);
      editor.focus();
    },
    [input, setIncoming, setText],
  );

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
        insertSkill: (skill, start, end) => {
          // IME input can change the editor before React has a new query to show.
          if (input.current?.value === text) insertSkill(skill, start, end);
        },
      },
    );
  };

  return { runPopupCommand, pick, insertSkill };
}
