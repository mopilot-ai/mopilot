// The composer's ↑/↓ prompt history: a chat's own prompts read from its transcript, so they survive a remount and a restart, plus what this window sent that no transcript shows.

import type { TurnState } from '../../shared/model/store';
import { bangCommand } from './bangMessage';
import { stripInjectedContext } from './format';

/** The most prompts one history keeps, newest kept. */
export const HISTORY_MAX = 200;
/** The history of the new-chat composer: what was sent from any composer in this window. */
export const RECENT = '';

const sent = new Map<string, string[]>();

/** What the person typed in each prompt of `turns`, oldest first; a `!` command's message reads as the command. */
export function transcriptPrompts(turns: readonly TurnState[] | undefined): string[] {
  const out: string[] = [];
  for (const turn of turns ?? []) {
    for (const item of turn.items) {
      if (item.type !== 'userMessage') continue;
      const raw = item.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
      const text = stripInjectedContext(raw).trim();
      if (text) out.push(bangCommand(text) ?? text);
    }
  }
  return out;
}

const push = (key: string, text: string) => {
  const list = sent.get(key) ?? [];
  if (list.at(-1) !== text) list.push(text);
  sent.set(key, list.slice(-HISTORY_MAX));
};

/** Remembers a prompt sent from the composer of `chatId` (null for a new chat), for its history and the new-chat one. */
export function recordPrompt(chatId: string | null, text: string): void {
  const value = text.trim();
  if (!value) return;
  if (chatId) push(chatId, value);
  push(RECENT, value);
}

/**
 * The prompts ↑ steps back through, oldest first: the chat's transcript, then what was sent here since its last prompt
 * that the transcript does not show yet (a queued message, a `!` command still running). Repeats in a row show once.
 */
export function promptHistory(chatId: string | null, turns: readonly TurnState[] | undefined): string[] {
  const shown = chatId ? transcriptPrompts(turns) : [];
  const inTranscript = new Set(shown);
  const mine = sent.get(chatId ?? RECENT) ?? [];
  // only what was sent after the last prompt the transcript shows is newer than it; anything earlier is in it or gone
  const after = mine.findLastIndex((t) => inTranscript.has(t)) + 1;
  const all = [...shown, ...mine.slice(after).filter((t) => !inTranscript.has(t))];
  return all.filter((t, i) => t !== all[i - 1]).slice(-HISTORY_MAX);
}

/** Forgets every sent prompt (tests). */
export function resetPromptHistory(): void {
  sent.clear();
}
