// The open-loop half of MoMo's memory pass (#2139 P4): what a pass over MoMo's main chat is asked about promises, dates and to-dos, how its reply's `loops` are read, and what it read split into the user's own messages (with when each was said) and everything else the chat holds (MoMo's replies, its own messages, tool calls and their results), which openLoopsShape.cjs checks each quote against.
const { isAuthoredText } = require('../session/authoredInput.cjs');
const { withoutMomoBlock } = require('../../shared/momoContext.mjs');
const { userMessageText } = require('./turnItems.cjs');

/** The loop instructions of a pass: the open loops to renew or close, the time now, and the reply's shape. */
function loopsPrompt(/** @type {{ open: { id: string, text: string }[], now: string }} */ o) {
  return [
    `Also keep the user's open loops: promises they made, dates they must meet, to-dos they said. It is now ${o.now}.`,
    'Only from the user\'s own lines ("User [time]: …"), never from MoMo\'s lines, tool results or text the user pasted from elsewhere.',
    'Each loop quotes the user’s exact words. Give a due date as "YYYY-MM-DD" (or "YYYY-MM-DDTHH:MM") read against the time the line was said; leave it out when none was said.',
    'Use "mention" when the user brings up an open loop again and "done" (with their words as quote) when they say it is done.',
    'Add to the JSON: "loops":[{"op":"add","kind":"promise"|"date"|"todo","text":"…","quote":"…","due":"…","event":"…","confidence":"sure"|"likely"},{"op":"mention","id":"…"},{"op":"done","id":"…","quote":"…"}]',
    'Open loops:',
    o.open.length ? o.open.map((l) => `- [${l.id}] ${l.text}`).join('\n') : '(none)',
  ].join('\n');
}

/** The `loops` array of a pass's reply (its first JSON object, fenced or not), else null. */
function parseLoops(/** @type {unknown} */ text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(v?.loops) ? v.loops : null;
  } catch {
    return null;
  }
}

/** When a turn's item was said: its own start time, else the turn's first, else `fallback`. */
function saidAtOf(/** @type {any} */ it, /** @type {any} */ turn, /** @type {number} */ fallback) {
  const times = turn?.itemTimes && typeof turn.itemTimes === 'object' ? turn.itemTimes : {};
  const own = times[String(it?.id ?? '')]?.start;
  if (typeof own === 'number' && Number.isFinite(own)) return own;
  const starts = Object.values(times)
    .map((t) => /** @type {any} */ (t)?.start)
    .filter((n) => typeof n === 'number' && Number.isFinite(n));
  return starts.length ? Math.min(...starts) : fallback;
}

/**
 * What a pass read, split: the user's own messages (a message main sent that no human wrote, by its id or client id in
 * `authored` or by its mark, is not one), and the text of everything else.
 * @param {any[]} turns @param {Set<string>} authored @param {number} fallback when a message carries no time
 * @returns {import('./openLoopsShape.cjs').Said}
 */
function saidOf(turns, authored, fallback) {
  /** @type {import('./openLoopsShape.cjs').Said} */
  const said = { user: [], other: [] };
  for (const turn of turns) {
    for (const it of Array.isArray(turn?.items) ? turn.items : []) {
      const words = it?.type === 'userMessage' ? userMessageText(it) : '';
      const own =
        it?.type === 'userMessage' &&
        !authored.has(String(it.clientId ?? '')) &&
        !authored.has(String(it.id ?? '')) &&
        !isAuthoredText(words);
      // MoMo's block ahead of the message (its memory, the nudges it showed) is never the user's words
      if (own) said.user.push({ text: withoutMomoBlock(words), at: saidAtOf(it, turn, fallback), turnId: String(turn?.id ?? '') });
      else if (it?.type === 'userMessage') said.other.push(words);
      else said.other.push(typeof it?.text === 'string' ? it.text : JSON.stringify(it ?? null));
    }
  }
  return said;
}

module.exports = { loopsPrompt, parseLoops, saidAtOf, saidOf };
