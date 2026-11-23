// Saving a composer's draft: attachment edits at once, typing after a short pause.

import { useEffect, useRef } from 'react';
import type { Attachment } from '../../store/types';

/** Attachment edits must reach source markers immediately; typing can wait for a short pause. */
export function useComposerDraft(
  draftKey: string,
  text: string,
  attachments: Attachment[],
  setDraft: (key: string, draft: { text: string; attachments: Attachment[]; goal?: boolean }) => void,
  goal?: boolean,
) {
  // the save still waiting for a pause in typing, with the draft it belongs to
  const pendingDraft = useRef<{ key: string; save: () => void } | null>(null);
  const previousDraft = useRef({ key: draftKey, attachments });
  useEffect(() => {
    const save = () => {
      pendingDraft.current = null;
      setDraft(draftKey, { text, attachments, ...(goal === undefined ? {} : { goal }) });
    };
    pendingDraft.current = { key: draftKey, save };
    const attachmentsChanged = previousDraft.current.key === draftKey && previousDraft.current.attachments !== attachments;
    previousDraft.current = { key: draftKey, attachments };
    if (attachmentsChanged) {
      save();
      return;
    }
    const timer = setTimeout(save, 200);
    return () => clearTimeout(timer);
  }, [text, attachments, goal, draftKey, setDraft]);
  // Changing chats or an approval card replacing the composer saves typing still waiting for its pause, into the
  // draft it was typed in. React runs this cleanup before the save effect runs for the next draft, so what is
  // pending is this draft's save (or nothing, once it was saved); the key check keeps that true if the order changes.
  useEffect(
    () => () => {
      const pending = pendingDraft.current;
      if (pending?.key === draftKey) pending.save();
    },
    [draftKey],
  );
}
