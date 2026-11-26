// What the phone puts on the wire for an intent: the home's own names and arguments (shared/momoIntents.mjs INTENT_TABLE), so a screen keeps its own intents and the table is the only contract. An intent the table has no entry for is answered here and never sent, so no request leaves for a kind MoMo cannot do.
import { say } from './say';
import type { Intent } from './types';

export type Wire = { kind: string; [arg: string]: unknown };

/** What the phone says to an action the home has no kind for yet. */
export const notYet = (): string => say('cantDoThatYet');

const approvals = { send: 'approval.send', edit: 'approval.edit', deny: 'approval.deny', 'ask-again': 'approval.askAgain' } as const;

/** The intent as the home's table names it, or null when the table has none (including the screen-local ones, which are never sent). */
/** How long Snooze puts a task off: one place, so it can become a choice later. */
export const SNOOZE_MS = 60 * 60 * 1000;

export function wireOf(intent: Intent): Wire | null {
  switch (intent.kind) {
    case 'open-where':
    case 'open-rules':
    case 'open-settings':
    case 'pick-machine':
    case 'retry-held':
    case 'add-machine':
    // the phone's own: a link it opens itself, the composer's own state, its own pairing flow
    case 'task-attach':
    case 'open-source':
      return null;
    case 'approval': {
      const body = intent.answer === 'edit' ? { body: intent.body ?? '' } : {};
      return { kind: approvals[intent.answer], id: intent.cardId, ...body };
    }
    case 'question':
      return { kind: 'question.answer', id: intent.id, optionId: intent.optionId };
    case 'task-act':
      return { kind: 'task.act', id: intent.taskId, fixId: intent.fixId };
    case 'offer':
      return { kind: intent.action === 'start' ? 'brief.start' : 'brief.hide', offerId: intent.offerId };
    case 'rule-undo':
      return { kind: 'rule.undo', id: intent.ruleId };
    case 'rule-set':
      return { kind: intent.on ? 'rule.turnOn' : 'rule.turnOff', id: intent.ruleId };
    case 'task-check':
      return { kind: 'task.check', id: intent.taskId };
    case 'task-snooze':
      return { kind: 'task.snooze', id: intent.taskId, forMs: SNOOZE_MS };
    case 'notice-draft-reply':
      return { kind: 'notice.draft', key: intent.noticeId };
    case 'notice-remind':
      return { kind: 'notice.remind', key: intent.noticeId };
    case 'task-stop':
      return { kind: 'task.stop', id: intent.taskId };
    case 'task-stop-watching':
      return { kind: 'task.stopWatching', id: intent.taskId };
    case 'task-retry':
      return intent.machineId
        ? { kind: 'task.runElsewhere', id: intent.taskId, machineId: intent.machineId }
        : { kind: 'task.retry', id: intent.taskId };
    case 'note-create':
      return { kind: 'note.write', title: intent.title, text: intent.text };
    case 'note-edit':
      return { kind: 'note.edit', noteId: intent.noteId, lineId: intent.lineId, text: intent.text };
    case 'note-forget':
      return { kind: 'note.forget', noteId: intent.noteId, lineId: intent.lineId };
    case 'note-undo':
      return { kind: 'note.undo', noteId: intent.noteId, changeId: intent.changeId };
    case 'note-restore':
      return { kind: 'note.restore', noteId: intent.noteId };
    case 'prefs':
      return { kind: 'settings.set', patch: intent.patch };
    case 'notice-not-needed':
      return { kind: 'row.notNeeded', rowId: intent.noticeId, ...(intent.decisionId ? { decisionId: intent.decisionId } : {}) };
    case 'google':
      return { kind: 'google', intent: intent.intent, client: 'ios' };
    case 'stop-turn':
      return { kind: 'stop-turn', turnId: intent.turnId };
    default:
      return { ...intent };
  }
}
