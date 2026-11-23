// DEV ONLY: a routine's report and MoMo's setup greeting, as the Mac puts them in MoMo's main chat for the phone (user-role rows whose text is the framing the model is sent, electron/momo/routineReport.cjs, starterRoutines.cjs), for the scenario `momo-report` (#4822). It only adds or removes rows in the fake chat; nothing is sent anywhere.
import { markedText, routineReportText, MODEL_MARK } from '../../shared/modelFraming.mjs';

export const SHAPES = Object.freeze(['done', 'failed', 'setup', 'off']);

/** The text each shape puts in the chat: the real builders' output, so the phone is checked against what the Mac sends. */
const TEXTS = {
  done: () => routineReportText('Inbox sweep', true, 'Two replies are due: Ana (the lease) and Raj (Friday lunch).'),
  failed: () => routineReportText('Weekly review', false, 'It stopped before the end: Calendar was not connected.'),
  setup: () => markedText('Setup', 'The user just finished setting you up. Greet them in one or two short sentences.'),
};

/**
 * The rows `momo-report <shape>` puts in a chat.
 * @param {string} shape done, failed, setup or off @param {{ id: string, rows: any[] }} chat @param {() => number} now
 * @returns {string} what happened
 */
export function raiseReport(shape, chat, now) {
  if (!SHAPES.includes(shape)) throw new Error(`The shape must be one of ${SHAPES.join(', ')}.`);
  if (shape === 'off') {
    const kept = chat.rows.filter((r) => !(r.role === 'user' && MODEL_MARK.test(String(r.text))));
    const removed = chat.rows.length - kept.length;
    chat.rows.splice(0, chat.rows.length, ...kept);
    return `${removed} report${removed === 1 ? '' : 's'} removed from MoMo's chat`;
  }
  chat.rows.push({
    role: 'user',
    text: TEXTS[/** @type {'done' | 'failed' | 'setup'} */ (shape)](),
    at: now(),
    id: `${chat.id}-r${chat.rows.length + 1}`,
  });
  return shape === 'setup'
    ? 'MoMo’s setup greeting is in its chat as the Mac sends it: the phone draws a one-line “MoPilot message”, never the instruction'
    : `a routine that ${shape === 'done' ? 'finished' : 'did not finish'} is in MoMo’s chat as the Mac sends it: the phone draws a one-line report card, its summary behind a tap, never the instruction`;
}
