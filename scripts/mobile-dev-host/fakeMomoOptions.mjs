// DEV ONLY: a question MoMo asked with answer chips, as the Mac puts it in MoMo's chat for the phone (an assistant row with `options`, electron/capabilities/browser/chromePanelLive.cjs, labels from shared/momoOptions.mjs), for the scenario `momo-options`.
import { readOptions } from '../../shared/momoOptions.mjs';

export const SHAPES = Object.freeze(['on', 'off']);

/** The reply as the model writes it; the row carries what the Mac sends: the text without the line, and the labels. */
const REPLY = 'Shall I move your 3 pm?\nOptions: Yes | No | Not now';

/**
 * The row `momo-options <shape>` puts in a chat.
 * @param {string} shape on or off @param {{ id: string, rows: any[] }} chat @param {() => number} now
 * @returns {string} what happened
 */
export function raiseOptions(shape, chat, now) {
  if (!SHAPES.includes(shape)) throw new Error(`The shape must be one of ${SHAPES.join(', ')}.`);
  if (shape === 'off') {
    const kept = chat.rows.filter((r) => !r.options);
    const removed = chat.rows.length - kept.length;
    chat.rows.splice(0, chat.rows.length, ...kept);
    return `${removed} question${removed === 1 ? '' : 's'} with answers removed from MoMo's chat`;
  }
  const { text, options } = readOptions(REPLY);
  chat.rows.push({ role: 'assistant', text, options, at: now(), id: `${chat.id}-r${chat.rows.length + 1}` });
  return 'a question with three answers (Yes, No, Not now) is the last reply in MoMo’s chat';
}
