// The chat's other cards over the shared row kinds (shared/momoView.ts): a question with answers to tap, a task's one result card and a watched source that changed. Text from a session is data: shown as plain text, never as a link or an action; the actions on a result are the home's own fix ids.
import type { MomoBriefView, MomoQuestionView, MomoResultView, MomoWatchChangedView } from '../../../shared/momoView';
import { clock } from './common';
import { say } from './say';
import type { Intent } from './types';

export type CardAction = { label: string; intent: Intent };
export type RowCard = { title: string; lines: string[]; meta: string | null; actions: CardAction[] };

/** The question card in each state; a status this phone does not know offers no way to answer. */
export function questionCard(q: MomoQuestionView, now: number): RowCard {
  const status = q.status === 'pending' && q.expiresAt !== null && q.expiresAt <= now ? 'expired' : q.status;
  const closed = (title: string, line: string): RowCard => ({ title, lines: [line], meta: null, actions: [] });
  const chosen = q.options.find((o) => o.id === q.answer?.optionId)?.label ?? q.answer?.optionId ?? '';
  switch (status) {
    case 'answered':
      return closed(q.title, chosen ? say('youChose', { option: chosen }) : say('answered'));
    case 'answered-elsewhere':
      return closed(
        say('answeredOn', { device: q.answer?.device || say('otherDevice'), time: q.answer ? clock(q.answer.at) : '' }),
        say('youChose', { option: chosen }),
      );
    case 'expired':
      return closed(say('expired'), say('answeredNothingDone'));
    case 'void':
      return closed(say('noLongerValid'), say('questionMomoMoved'));
    case 'pending':
      return {
        title: q.title,
        lines: q.body ? [q.body] : [],
        meta: null,
        actions: q.options.map((o) => ({ label: o.label, intent: { kind: 'question', id: q.id, optionId: o.id } })),
      };
    default:
      return closed(q.title, say('updateToAnswer'));
  }
}

const stateWord = (state: string): string | null =>
  state === 'done'
    ? say('resultReady')
    : state === 'needs_you'
      ? say('resultNeedsYou')
      : state === 'failed'
        ? say('resultCouldNotFinish')
        : null;

/** The one card a task leaves in the chat when it settles. */
export function resultCard(r: MomoResultView): RowCard {
  const word = stateWord(r.state);
  return {
    title: r.title,
    meta: word ? `${word} · ${r.machine.name}` : r.machine.name,
    lines: [r.summary, ...(r.files.length ? [r.files.join(', ')] : []), ...(r.checked ? [say('checkedText', { text: r.checked })] : [])],
    actions: r.actions.map((a) => ({ label: a.label, intent: { kind: 'task-act', taskId: r.taskId, fixId: a.id } })),
  };
}

/** A watched source that changed: what, and where it is watched from. */
export const watchCard = (w: MomoWatchChangedView): RowCard => ({
  title: w.title,
  lines: [w.detail],
  meta: say('watchingFrom', { name: w.machine.name }),
  actions: [],
});

/** The mail a rule kept quiet out of the brief, each with the home's words for it; "Undo rule" only on a line whose rule is known. A brief without the field has none. */
export const keptQuietLines = (b: MomoBriefView) =>
  (b.keptQuiet ?? []).map((k) => ({
    id: k.id,
    title: k.title,
    label: k.label,
    undo: k.ruleId ? { label: say('undoRule'), intent: { kind: 'rule-undo', ruleId: k.ruleId } as Intent } : null,
  }));
