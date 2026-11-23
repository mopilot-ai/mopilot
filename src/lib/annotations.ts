// Selection and annotation attachments in a draft: creating, editing and removing quoted text and its note.

import type { Attachment } from '../../shared/model/store';
import type { DiffCommentRange } from '../../shared/diffComments.mjs';

export function selectionAttachment(text: string): Attachment {
  return { kind: 'selection', path: '', name: 'Selection', text };
}

export function annotationAttachment(text: string, source?: Attachment['source'], annotation = ''): Attachment {
  return { ...selectionAttachment(text), name: 'Annotation', annotation, annotationId: crypto.randomUUID(), source };
}

/** A comment on a range of diff lines; its hunk is the quoted text. */
export function diffCommentAttachment(diff: DiffCommentRange, comment: string): Attachment {
  return { ...annotationAttachment(diff.hunk, undefined, comment), name: 'Diff comment', diff };
}

export function updateAnnotation(items: Attachment[], id: string, annotation: string): Attachment[] {
  return items.map((item) => (item.annotationId === id ? { ...item, annotation } : item));
}

export function removeAnnotation(items: Attachment[], id: string): Attachment[] {
  return items.filter((item) => item.annotationId !== id);
}

export function editSelection(items: Attachment[], index: number, annotation: string): Attachment[] {
  const selected = items.filter((a) => a.kind === 'selection')[index];
  return items.map((a) => (a === selected ? { ...a, annotation, annotationId: a.annotationId ?? crypto.randomUUID() } : a));
}

export function removeSelection(items: Attachment[], index: number): Attachment[] {
  const selected = items.filter((a) => a.kind === 'selection')[index];
  return items.filter((a) => a !== selected);
}
