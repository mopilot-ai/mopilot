// An input main sent into a chat that no human wrote (MoMo's routine result, a routine's first message, #2287), as the chat's meta `authored` records it (electron/session/authoredInput.cjs): who it is from and what may be shown in its place.
import type { AuthoredInput } from '../../shared/model/window';
import { markedCard } from '../../shared/modelFraming.mjs';
export type { AuthoredInput } from '../../shared/model/window';

/** Who each author is, as the transcript names it. */
export const AUTHOR_LABEL: Record<AuthoredInput['by'], string> = { momo: 'MoMo', mopilot: 'MoPilot' };

/**
 * The presentation of a thread item main sent no human wrote, matched by the client id main gave it (as
 * sideSessionForItem is), or null for the user's own input. Only main writes these records, so a message the user typed
 * is never shown as another's, whatever it says. (A message with no record is read by markedInputFor.)
 */
export function authoredFor(
  inputs: Record<string, Record<string, AuthoredInput>> | undefined,
  chatId: string,
  item: { id?: string; clientId?: string | null },
): AuthoredInput | null {
  const own = inputs && Object.hasOwn(inputs, chatId) ? inputs[chatId] : undefined;
  for (const key of own ? [item.clientId, item.id] : []) {
    const a = key && own && Object.hasOwn(own, key) ? own[key] : undefined;
    if (a && typeof a.title === 'string' && Object.hasOwn(AUTHOR_LABEL, a.by)) return a;
  }
  return null;
}

/**
 * A user message with no record (its record was dropped, or its chat was read back from a harness's history) is still
 * never shown as MoMo's framing for the model: the mark its text starts with (shared/modelFraming.mjs) gives its
 * labelled card, a routine report's name and summary or just its label. Makes a new object: call it outside a store
 * selector.
 */
export function markedInputFor(item: { type?: string; content?: unknown }): AuthoredInput | null {
  if (item.type !== 'userMessage') return null;
  const parts = (Array.isArray(item.content) ? item.content : []) as { type?: string; text?: string }[];
  const card = markedCard(
    parts
      .filter((c) => c?.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n'),
  );
  return card
    ? {
        by: card.kind === 'marked' ? 'mopilot' : 'momo',
        title: card.kind === 'marked' ? 'MoPilot message' : card.title,
        ...(card.body ? { body: card.body } : {}),
        at: 0,
      }
    : null;
}
