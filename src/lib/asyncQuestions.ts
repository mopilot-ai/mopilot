// Questions an agent reply asks the user: detecting them, sending the answers and splitting a turn around them.

import type { ThreadItem } from '../protocol/v2/ThreadItem';
import type { StatusNoteItem } from '../../shared/model/store';

import { hasAsyncQuestions, type AsyncQuestionsItem } from '../../shared/asyncQuestionAnswers.mjs';
export {
  hasAsyncQuestions,
  asyncAnswersReady,
  sendAsyncAnswers,
  submittedAsyncAnswers,
  type AsyncQuestionsItem,
} from '../../shared/asyncQuestionAnswers.mjs';

/**
 * The questions that wait for the user docked above the composer, as Claude Code docks its question card: the latest
 * turn's last questions, until they are answered or the user writes to the agent after them. Older ones stay in the
 * transcript, answerable where they were asked.
 */
export function dockedAsyncQuestions(
  turns: readonly { items: ThreadItem[] }[],
  submitted: ReadonlyMap<string, Record<number, string>>,
): AsyncQuestionsItem | null {
  const items = turns[turns.length - 1]?.items ?? [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type === 'userMessage') return null;
    if (hasAsyncQuestions(item)) return submitted.has(item.id) ? null : item;
  }
  return null;
}

const NO_ANSWERS: ReadonlyMap<string, Record<number, string>> = new Map();
const questionItems = new WeakMap<ThreadItem[], AsyncQuestionsItem[]>();

/** The store replaces an item array when its items change; a delta never re-scans settled turns' tool work. */
function questionsOf(items: ThreadItem[]): AsyncQuestionsItem[] {
  let questions = questionItems.get(items);
  if (!questions) questionItems.set(items, (questions = items.filter(hasAsyncQuestions)));
  return questions;
}

/**
 * The submitted answers to each turn's own questions, by turn id. A turn whose answers read the same as in
 * `previous` keeps that map, so a turn's view sees a new map only when one of its own questions was answered.
 */
export function asyncAnswersByTurn(
  turns: { id: string; items: ThreadItem[] }[],
  submitted: ReadonlyMap<string, Record<number, string>>,
  previous?: ReadonlyMap<string, ReadonlyMap<string, Record<number, string>>>,
): Map<string, ReadonlyMap<string, Record<number, string>>> {
  const out = new Map<string, ReadonlyMap<string, Record<number, string>>>();
  for (const turn of turns) {
    const own = new Map<string, Record<number, string>>();
    for (const item of questionsOf(turn.items)) {
      const answers = submitted.get(item.id);
      if (answers) own.set(item.id, answers);
    }
    const before = previous?.get(turn.id);
    out.set(turn.id, own.size === 0 ? NO_ANSWERS : before && sameAnswers(before, own) ? before : own);
  }
  return out;
}

const sameAnswers = (a: ReadonlyMap<string, Record<number, string>>, b: ReadonlyMap<string, Record<number, string>>) =>
  a.size === b.size && [...b].every(([id, answers]) => JSON.stringify(a.get(id)) === JSON.stringify(answers));

/**
 * Keep questions outside the collapsible tool work, in their original transcript position; so too `headId`'s item
 * (a plan approved mid-turn, which the work after it follows).
 */
export function splitWorkChunks(
  items: ThreadItem[],
  headId?: string,
): ({ kind: 'head'; item: ThreadItem | StatusNoteItem } | { kind: 'work'; items: ThreadItem[] })[] {
  const out: ({ kind: 'head'; item: ThreadItem | StatusNoteItem } | { kind: 'work'; items: ThreadItem[] })[] = [];
  let work: ThreadItem[] = [];
  const flush = () => {
    if (work.length) out.push({ kind: 'work', items: work });
    work = [];
  };
  for (const item of items) {
    if (
      item.type === 'userMessage' ||
      item.type === 'hookPrompt' ||
      (item as ThreadItem | StatusNoteItem).type === 'statusNote' ||
      hasAsyncQuestions(item) ||
      (headId !== undefined && item.id === headId)
    ) {
      flush();
      out.push({ kind: 'head', item });
    } else work.push(item);
  }
  flush();
  return out;
}

/** Items that can follow a turn's reply without being its answer. */
const AFTER_REPLY = new Set<string>(['statusNote', 'hookPrompt']);

export function splitTurn(items: ThreadItem[], running: boolean) {
  const users: ThreadItem[] = [];
  let i = 0;
  // A turn opens with the user's message(s), or with a status note when Claude Code started it on its own.
  while (i < items.length && (items[i].type === 'userMessage' || (items[i] as ThreadItem | StatusNoteItem).type === 'statusNote'))
    users.push(items[i++]);
  const rest = items.slice(i).filter((x) => !(x.type === 'agentMessage' && !x.text?.trim() && !hasAsyncQuestions(x) && !running));
  let final: ThreadItem | null = null;
  const fi = rest.findIndex((x) => x.type === 'agentMessage' && x.phase === 'final_answer' && !hasAsyncQuestions(x));
  if (fi >= 0) final = rest[fi];
  else {
    // The last reply is the answer once the turn ends. While it runs, a reply at the end (Claude's
    // replies carry no phase) is shown there already, so it doesn't jump when the turn completes. Notes
    // after it don't count: a chat's saved notes come back behind the reply of the turn they followed, and a
    // hook that failed after the reply (a Stop hook) reports its line there.
    let end = rest.length - 1;
    while (end >= 0 && AFTER_REPLY.has((rest[end] as ThreadItem | StatusNoteItem).type)) end--;
    const last = rest[end] as ThreadItem | undefined;
    if (last?.type === 'agentMessage' && !hasAsyncQuestions(last) && (!running || (!last.phase && last.text?.trim()))) final = last;
  }
  return { users, work: rest.filter((x) => x !== final), final };
}
