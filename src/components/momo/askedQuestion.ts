// A question asked from Quick Chat in MoMo's chat as Quick Chat shows it (#2288): main shows a turn's message only to an
// app window (a turn's turnStarting goes to the window it came from unless that is Quick Chat, electron/app/windows.cjs
// stepWindows), so Quick Chat shows its own copy, as an early turn the harness may adopt (src/store/earlyTurn.ts), and
// drops it once the chat holds the message itself.
import { newTurn, patchRuntime } from '../../store/core';
import { earlyTurnId } from '../../store/pendingTurns';
import type { TurnState } from '../../store/types';

type Item = { type?: string; id?: string; content?: unknown };

/** The text of a user message's content (its text parts, joined). */
const textOf = (content: unknown) =>
  Array.isArray(content)
    ? content
        .map((c) =>
          c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : '',
        )
        .join('')
    : '';

/** The question shown at once in a turn of its own, finished (Quick Chat shows no queue or running state for it). */
export function showAsked(chatId: string, id: string, text: string) {
  const turnId = earlyTurnId(id);
  const bubble = { type: 'userMessage', id: `local-${id}`, clientId: id, content: [{ type: 'text', text, text_elements: [] }] };
  patchRuntime(chatId, (r) => ({
    turns: [
      ...r.turns.filter((t) => t.id !== turnId),
      { ...newTurn(turnId), status: 'completed', items: [bubble as unknown as TurnState['items'][number]] },
    ],
  }));
}

/** The question taken back: its send failed, and the text is in the box again. */
export function dropAsked(chatId: string, id: string) {
  const turnId = earlyTurnId(id);
  patchRuntime(chatId, (r) => ({ turns: r.turns.filter((t) => t.id !== turnId) }));
}

/**
 * The questions among `ids` the chat now holds in a turn of its own (a harness that shows Quick Chat the message, or a
 * read of the chat): their copies go, so the question shows once.
 */
export function heldAsked(turns: readonly TurnState[] | undefined, asked: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [id, text] of asked) {
    const own = earlyTurnId(id);
    if (!turns?.some((t) => t.id === own)) continue;
    const held = turns.some(
      (t) => t.id !== own && (t.items as Item[]).some((i) => i.type === 'userMessage' && textOf(i.content).includes(text)),
    );
    if (held) out.push(id);
  }
  return out;
}
