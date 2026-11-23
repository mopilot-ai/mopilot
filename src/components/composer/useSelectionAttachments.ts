// Routing quoted selections to the right composer's attachments, including a side chat's.

import { useEffect, useLayoutEffect, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { flushSync } from 'react-dom';
import { removeAnnotation, updateAnnotation } from '../../lib/annotations';
import { removeComposerAnnotation, retainComposerAttachment, retainComposerAnnotation } from '../../session/composerAttach';
import { receiveComposerSelection } from '../../lib/composerEvents';
import type { Attachment } from '../../store/types';

/** Route selection events to their own composer, including when a side chat is open. */
export function useSelectionAttachments(
  threadId: string | null,
  setAttachments: Dispatch<SetStateAction<Attachment[]>>,
  inputRef: RefObject<{ focus: () => void } | null>,
  admit?: (attachment: Attachment) => boolean,
) {
  const [receipt, setReceipt] = useState<{ threadId: string | null; committed: boolean } | null>(null);
  useLayoutEffect(() => {
    if (receipt && receipt.threadId === threadId) receipt.committed = true;
  }, [receipt, threadId]);
  useEffect(() => {
    let active = true;
    const add = (e: Event) =>
      receiveComposerSelection(e, threadId, {
        appendSelection: (attachment) => {
          if (admit && !admit(attachment)) return { committed: false, refused: true };
          const next = { threadId, committed: false };
          setReceipt(next);
          setAttachments((items) => [...items, attachment]);
          return next;
        },
        focus: () => inputRef.current?.focus(),
        current: () => active,
        retainSelection: (attachment) => retainComposerAttachment(threadId, attachment),
      });
    const update = (e: Event) => {
      const d = (e as CustomEvent).detail as { threadId: string; annotationId: string; annotation: string };
      if (d.threadId !== threadId) return;
      const next = { threadId, committed: false };
      flushSync(() => {
        setReceipt(next);
        setAttachments((items) => updateAnnotation(items, d.annotationId, d.annotation));
      });
      if (!next.committed) retainComposerAnnotation(threadId, d.annotationId, d.annotation);
    };
    const remove = (e: Event) => {
      const d = (e as CustomEvent).detail as { threadId: string; annotationId: string };
      if (d.threadId !== threadId) return;
      const next = { threadId, committed: false };
      flushSync(() => {
        setReceipt(next);
        setAttachments((items) => removeAnnotation(items, d.annotationId));
      });
      if (!next.committed) removeComposerAnnotation(threadId, d.annotationId);
    };
    window.addEventListener('composer-add-selection', add);
    window.addEventListener('composer-update-selection', update);
    window.addEventListener('composer-remove-selection', remove);
    return () => {
      active = false;
      window.removeEventListener('composer-add-selection', add);
      window.removeEventListener('composer-update-selection', update);
      window.removeEventListener('composer-remove-selection', remove);
    };
  }, [threadId, setAttachments, inputRef, admit]);
}
