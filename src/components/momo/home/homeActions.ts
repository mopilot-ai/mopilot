// The user's moves on MoMo's home surfaces, as data: the one vocabulary the screens dispatch and the home lane's IPC seam answers.
import type { MomoRuleEffect } from '../../../../shared/momoView';

export type MomoHomeAction =
  // where it lives
  | { type: 'setup.choose'; machineId: string }
  | { type: 'setup.next' }
  | { type: 'setup.open' }
  | { type: 'setup.google'; to: 'waiting' | 'connected' | 'failed' | 'idle' }
  | { type: 'setup.notifications'; to: 'allowed' | 'denied' }
  | { type: 'move.start'; machineId: string }
  | { type: 'move.stay' }
  | { type: 'intent'; intent: unknown }
  | { type: 'move.cancel' }
  | { type: 'move.retry' }
  | { type: 'move.dismiss' }
  | { type: 'home.reclaim'; moveId: string; toId: string }
  | { type: 'home.wake' }
  | { type: 'home.useOtherAgent' }
  | { type: 'machine.setUp'; machineId: string }
  | { type: 'machine.update'; machineId: string }
  // chat
  | { type: 'chat.send'; turnId: string; text: string }
  | { type: 'chat.check'; rowId: string }
  | { type: 'brief.hide'; offerId: string }
  | { type: 'brief.start'; offerId: string }
  // approval card
  | { type: 'approval.send'; id: string }
  | { type: 'approval.edit'; id: string; body: string }
  | { type: 'approval.deny'; id: string }
  | { type: 'approval.askAgain'; id: string }
  | { type: 'question.answer'; id: string; optionId: string }
  | { type: 'row.notNeeded'; rowId: string }
  // tasks
  | { type: 'task.stop'; id: string }
  | { type: 'task.retry'; id: string }
  | { type: 'task.runElsewhere'; id: string; machineId: string }
  | { type: 'fix.run'; id: string }
  | { type: 'task.act'; id: string; fixId: string }
  | { type: 'task.stopWatching'; id: string }
  // notes
  | { type: 'note.edit'; noteId: string; lineId: string; text: string }
  | { type: 'note.undo'; noteId: string; changeId: string }
  | { type: 'note.restore'; noteId: string }
  | { type: 'note.forget'; noteId: string }
  | { type: 'note.write'; title: string; text: string }
  | { type: 'source.reconnect'; id: string }
  | { type: 'source.remove'; id: string }
  // rules
  | { type: 'rule.add'; text: string; effect: MomoRuleEffect }
  | { type: 'rule.edit'; id: string; text: string; effect: MomoRuleEffect; inBrief: boolean }
  | { type: 'rule.undo'; id: string }
  | { type: 'rule.turnOff'; id: string }
  | { type: 'rule.accept'; id: string }
  | { type: 'rule.turnOn'; id: string }
  | { type: 'signal.make'; id: string }
  | { type: 'signal.ignore'; id: string }
  // settings
  | {
      type: 'settings.set';
      patch: Partial<{ briefOn: boolean; briefTime: string; quietFrom: string; quietTo: string; dailyCap: number; previews: boolean }>;
    };

/** What an action's call answers: done (with a line the home wants said, such as that Google could not be reached to remove MoPilot there), or the real cause with the label of the one-click fix. */
export type MomoHomeResult = { ok: true; notice?: string } | { ok: false; cause: string; fix?: { label: string; intent: unknown } };
