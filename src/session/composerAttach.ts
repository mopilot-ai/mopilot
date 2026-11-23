// Adding an attachment to a chat's composer from outside it: the open composer takes it, else its stored draft does.

import { removeAnnotation, updateAnnotation } from '../lib/annotations';
import { get as getState, setDraft, toast } from '../store/core';
import { onMachineNow } from '../lib/hostChats';
import { newChatHostPick } from '../store/projects';
import type { Attachment } from '../store/types';

/**
 * Puts an attachment into the composer of `threadId` (null: the new-chat composer). An open composer takes it
 * through the selection event (and takes focus unless `focus` is false); otherwise its stored draft does.
 */
export function attachToComposer(threadId: string | null, attachment: Attachment, { focus = true } = {}) {
  if (attachment.kind !== 'image' && attachment.kind !== 'selection' && (threadId ? onMachineNow(threadId) : newChatHostPick())) {
    // a file named from a panel may be a path on the machine, not on this Mac: the composer's own Files and folders is the way to attach one from here
    toast('Only images can be attached from here to a machine chat. Use Files and folders in the composer for other files.');
    return false;
  }
  const detail = { threadId, text: '', attachment, handled: false, refused: false, focus };
  window.dispatchEvent(new CustomEvent('composer-add-selection', { detail }));
  if (detail.refused) return false;
  if (!detail.handled) retainComposerAttachment(threadId, attachment);
  return true;
}

/** Retain one uncommitted delivery; each independent operation appends even when payload objects are shared. */
export function retainComposerAttachment(threadId: string | null, attachment: Attachment) {
  const key = threadId ?? 'home';
  const draft = getState().drafts[key];
  setDraft(key, { ...draft, text: draft?.text ?? '', attachments: [...(draft?.attachments ?? []), attachment] });
}

/** A comment accepted before disposal still belongs to the originating draft. */
export function retainComposerAnnotation(threadId: string | null, annotationId: string, annotation: string) {
  const key = threadId ?? 'home';
  const draft = getState().drafts[key];
  if (!draft) return;
  setDraft(key, { ...draft, attachments: updateAnnotation(draft.attachments ?? [], annotationId, annotation) });
}

/** A deletion accepted before disposal still removes the annotation from the originating draft. */
export function removeComposerAnnotation(threadId: string | null, annotationId: string) {
  const key = threadId ?? 'home';
  const draft = getState().drafts[key];
  if (!draft) return;
  setDraft(key, { ...draft, attachments: removeAnnotation(draft.attachments ?? [], annotationId) });
}

/** Deletes an annotation from where it was made: the open composer drops it at once, and its stored draft does too. */
export function deleteComposerAnnotation(threadId: string | null, annotationId: string) {
  window.dispatchEvent(new CustomEvent('composer-remove-selection', { detail: { threadId, annotationId } }));
  removeComposerAnnotation(threadId, annotationId);
}
