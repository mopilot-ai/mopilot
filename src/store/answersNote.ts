// The answers given to an agent's question card, kept in the chat after its last turn and in the chat's file.
import type { ChatNote } from '../lib/chatMeta';
import { answeredQuestions, answeredSummary, type AskedQuestion, type QuestionResult } from '../lib/answeredQuestions';
import type { StatusNoteItem, ThreadItem } from './types';
import { get, set, patchTurn } from './core';

/**
 * Record what a question card was answered with: a note after the chat's last turn, kept in the chat's notes so a
 * reload (whose history the harness rebuilds without the card) shows it again. Any harness's card goes through
 * here. False when the chat has no turn to follow, or the card asked nothing.
 */
export function answersNote(chatId: string, questions: readonly AskedQuestion[], result: QuestionResult): boolean {
  const answers = answeredQuestions(questions, result);
  const rt = get().runtime[chatId];
  const last = rt?.turns[rt.turns.length - 1];
  if (!last || !answers.length) return false;
  const note: ChatNote = {
    id: `answers-${crypto.randomUUID()}`,
    kind: 'answers',
    text: answeredSummary(answers),
    answers,
    turnId: last.id.startsWith('pending-') ? null : last.id,
    turn: rt.turns.length - 1,
    at: Date.now(),
  };
  const item: StatusNoteItem = { type: 'statusNote', id: note.id, kind: 'answers', text: note.text, answers };
  patchTurn(chatId, last.id, (t) => ({ items: [...t.items, item as unknown as ThreadItem] }));
  set((s) => ({ chatNotes: { ...s.chatNotes, [chatId]: [...(s.chatNotes[chatId] ?? []), note] } }));
  return true;
}
