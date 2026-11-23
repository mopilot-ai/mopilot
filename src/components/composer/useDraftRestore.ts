// Showing a composer's saved draft when its draft key changes, with the caret at its end on the next frame unless typing came first.

import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { onFrameUnlessTyped, typingElsewhere } from '../../lib/focus';
import { get as getState } from '../../store/core';
import type { Attachment } from '../../store/types';
import type { ComposerPopup } from '../../lib/composerSkills';
import type { ComposerInputElement } from './ComposerInput';

/** The setters are React state setters and `takesFocus` is stable (useComposerText): only a new draft key restores. */
export function useDraftRestore(
  draftKey: string,
  taRef: RefObject<ComposerInputElement | null>,
  takesFocus: () => boolean,
  setText: Dispatch<SetStateAction<string>>,
  setGoalMode: Dispatch<SetStateAction<boolean>>,
  setAttachments: Dispatch<SetStateAction<Attachment[]>>,
  setPopup: Dispatch<SetStateAction<ComposerPopup | null>>,
) {
  useEffect(() => {
    const d = getState().drafts[draftKey];
    setText(d?.text ?? '');
    setGoalMode(d?.goal ?? false);
    setAttachments(d?.attachments ?? []);
    setPopup(null);
    // a frame that runs late (a window the OS has not painted) finds the user already typing here: the caret is theirs
    onFrameUnlessTyped(taRef.current, () => {
      const ta = taRef.current;
      // don't take the keyboard from a field the user is typing in (the terminal, a search box), or from the focused pane
      if (!ta || typingElsewhere(ta) || !takesFocus()) return;
      ta.focus();
      ta.setCaretAfter(ta.value, ta.value.length);
    });
  }, [draftKey, taRef, takesFocus, setText, setGoalMode, setAttachments, setPopup]);
}
