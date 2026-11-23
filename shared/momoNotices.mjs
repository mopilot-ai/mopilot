// MoMo's notification texts (#2139): the fixed title MoMo's notice shows, and the one optional body (A6, opt-in, the name of the user's own routine). Nothing a chat or a source wrote ever goes into one, so nothing personal reaches the lock screen.
import { prefixUnits } from './textPrefix.mjs';

/** The notice's whole text: a short title, no body. MoMo notifies when it needs the user (an approval or a question in a MoMo chat). */
export const MOMO_NOTICE_TITLES = Object.freeze({ needsYou: 'MoMo needs you' });

/** What several waiting at once say. */
export const momoMergedTitle = (/** @type {number} */ n) => `MoMo needs you (${n})`;

/** The longest routine name a push body carries, in UTF-16 units. */
export const MOMO_PUSH_BODY_MAX_UNITS = 40;

/**
 * The only text a MoMo push may carry besides its fixed title: the name of a routine the user approved, shaped for a
 * lock screen, or '' for none. The one source is `routine.name`: nothing else is read (tests/momoPushBody.invariant.test.ts),
 * so no mail, calendar, reminder, memory, nudge or chat text can reach it.
 * @param {{ optIn: boolean, routine: { name?: unknown, approved?: unknown } | null | undefined }} o `optIn`: prefs.momo.notify.pushBody; `routine`: the routine whose run raised the notice
 */
export function momoPushBody({ optIn, routine }) {
  if (optIn !== true || routine?.approved !== true || typeof routine.name !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const spaced = routine.name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ');
  return prefixUnits(spaced.trim(), MOMO_PUSH_BODY_MAX_UNITS).trim();
}
