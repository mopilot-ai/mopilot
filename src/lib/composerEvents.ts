// Window events that focus a composer or add a selection to its draft, targeted at a chat.

import { flushSync } from 'react-dom';
import { annotationAttachment, selectionAttachment } from './annotations';
import type { Attachment } from '../../shared/model/store';

interface ComposerSelection {
  threadId: string;
  text: string;
  comment?: string;
  handled?: boolean;
  refused?: boolean;
  attachment?: Attachment;
  focus?: boolean;
}

/**
 * Untargeted shortcuts focus the main composer, the focused pane's (`main`); targeted events can focus a side chat or
 * a pane that isn't focused.
 */
export function focusComposer(event: Event, threadId: string | null, main: boolean, focus: () => void) {
  const target = (event as CustomEvent<{ threadId: string }>).detail?.threadId;
  if (target ? target === threadId : main) focus();
}

/** Commit or retain a selection before acknowledging delivery, so disposal cannot discard an accepted edit. */
export function receiveComposerSelection(
  event: Event,
  threadId: string | null,
  actions: {
    appendSelection(attachment: Attachment): { committed: boolean; refused?: boolean };
    focus(): void;
    current(): boolean;
    retainSelection(attachment: Attachment): void;
  },
) {
  const detail = (event as CustomEvent<ComposerSelection>).detail;
  if (detail.threadId !== threadId || detail.handled) return;
  const attachment =
    detail.attachment ??
    (detail.comment === undefined ? selectionAttachment(detail.text) : annotationAttachment(detail.text, undefined, detail.comment));
  let receipt: { committed: boolean; refused?: boolean };
  flushSync(() => {
    receipt = actions.appendSelection(attachment);
  });
  if (receipt!.refused) {
    detail.refused = true;
    detail.handled = true;
    return;
  }
  const current = actions.current();
  if (!receipt!.committed) actions.retainSelection(attachment);
  detail.handled = true;
  if (current && detail.focus !== false) actions.focus();
}

/** False means no composer received it; a refusal must never trigger the unmounted-composer fallback. */
export function dispatchComposerSelection(target: EventTarget, threadId: string, text: string): boolean | 'refused' {
  const detail: ComposerSelection = { threadId, text, handled: false };
  target.dispatchEvent(new CustomEvent('composer-add-selection', { detail }));
  return detail.refused ? 'refused' : !!detail.handled;
}

export function dispatchComposerFocus(target: EventTarget, threadId: string) {
  target.dispatchEvent(new CustomEvent('focus-composer', { detail: { threadId } }));
}

/**
 * Put text (and attachments) in a chat's composer when it is on screen (appending by default; queued edits prepend). False means
 * no composer took it, so the chat's stored draft must.
 */
export function dispatchComposerText(
  target: EventTarget,
  threadId: string | null,
  text: string,
  attachments: unknown[] = [],
  prepend = false,
): boolean {
  const detail = { threadId, text, attachments, prepend, handled: false };
  target.dispatchEvent(new CustomEvent('composer-insert', { detail }));
  return detail.handled;
}

/** Commit accepted chat-targeted input before acknowledgement, so unmount cannot discard queued React updates. */
export function receiveComposerText(
  event: Event,
  threadId: string | null,
  main: boolean,
  insert: (text: string, attachments: Attachment[], prepend: boolean) => { committed: boolean },
) {
  const detail = (event as CustomEvent).detail as
    | string
    | { threadId: string; text: string; attachments?: Attachment[]; prepend?: boolean; handled?: boolean };
  // an untargeted insert (a starter prompt, a plugin's) goes to the focused pane's composer alone
  if (typeof detail === 'string') {
    if (main) insert(detail, [], false);
    return;
  }
  if (detail.threadId !== threadId) return;
  let receipt: { committed: boolean };
  flushSync(() => {
    receipt = insert(detail.text, detail.attachments ?? [], !!detail.prepend);
  });
  if (receipt!.committed) detail.handled = true;
}
