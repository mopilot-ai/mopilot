// What a paired phone may do of MoMo's home beyond naming the method: a lane intent only of the kinds its screens send, so a stolen unlocked phone cannot run a registry kind its own UI never offers (a rule switched on or off changes what passes without a card, so the rule kinds stay with the Mac).
import { HostRefusal } from './hostFs.mjs';

/** The lane kinds the phone's screens send (read from mobile/src/momoPhone/wire.ts by tests/hostMomoPhoneNarrow.test.ts, so this list cannot drift from it). */
export const PHONE_LANE_KINDS = Object.freeze([
  'approval.askAgain',
  'approval.deny',
  'approval.edit',
  'approval.send',
  'brief.hide',
  'brief.start',
  'note.edit',
  'note.forget',
  'note.restore',
  'note.undo',
  'note.write',
  'notice.draft',
  'notice.remind',
  'question.answer',
  'row.notNeeded',
  'settings.set',
  'task.act',
  'task.check',
  'task.retry',
  'task.runElsewhere',
  'task.snooze',
  'task.stop',
  'task.stopWatching',
]);

/** @param {unknown} who the connection a handler is given */
const isPhone = (who) => /** @type {any} */ (who)?.principal?.()?.kind === 'phone';

/** The refusal every phone is told for what its list does not allow (the same words as the entry's). */
const refused = () => new HostRefusal('forbidden', 'This phone may not do that on this machine.');

/** A phone runs only the lane kinds in PHONE_LANE_KINDS. @param {unknown} who @param {string} kind */
export function narrowLane(who, kind) {
  if (isPhone(who) && !PHONE_LANE_KINDS.includes(kind)) throw refused();
}
