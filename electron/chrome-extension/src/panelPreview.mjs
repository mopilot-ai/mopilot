// The side panel's streamed reply (panelThread.mjs) against a read of the chat: the part of the running turn's reply the read's rows don't hold yet, whatever the harness's history holds of a reply still being written.
//
// A harness's history may hold the reply being written (Codex's thread), only its finished messages, or none of it
// until the turn ends (Claude Code's transcript, #2116). The panel keeps all the text the turn streamed; a read shows
// what follows the part its rows hold. The rows hold a part when the replies after the turn's message start the same
// way. Text is compared without its whitespace, which a transcript may lay out differently from the stream.

/** How many of the last user messages may be the turn's own (a follow-up steered into it adds one). */
export const TURNS = 5;
/** The shortest end of a row taken as the start of a reply the panel joined mid-way (fewer could be chance). */
export const MIN_OVERLAP = 8;

const squash = (/** @type {string} */ t) => t.replace(/\s+/g, '');

/** `reply` past its first `n` letters (whitespace not counted). */
function past(/** @type {string} */ reply, /** @type {number} */ n) {
  let i = 0;
  for (let k = 0; k < n; i++) if (!/\s/.test(reply[i])) k++;
  return reply.slice(i).trimStart();
}

/** The longest start of `a` that `b` ends with (Knuth-Morris-Pratt), or a.length when `b` holds all of `a`. */
function overlap(/** @type {string} */ a, /** @type {string} */ b) {
  const fail = [0];
  for (let i = 1, k = 0; i < a.length; i++) {
    while (k && a[i] !== a[k]) k = fail[k - 1];
    if (a[i] === a[k]) k++;
    fail[i] = k;
  }
  let q = 0;
  for (const c of b) {
    while (q && c !== a[q]) q = fail[q - 1];
    if (c === a[q]) q++;
    if (q === a.length) return q;
  }
  return q;
}

/**
 * Of the turn's streamed reply, the text the rows don't hold: '' when they hold all of it, what follows the start they
 * hold, and all of it when they hold none. Rows whose reply goes another way are not this one's: all of it shows while
 * the turn runs, nothing once it ended (its rows are all there is then).
 * @param {string} reply all the text the turn streamed (since the panel opened the chat, when it opened mid-turn)
 * @param {{ role: string, text: string }[]} rows the read's rows
 * @param {{ over?: boolean, joined?: boolean }} [o] over: the turn ended; joined: the panel opened the chat mid-turn,
 *   so the reply it has may start mid-way through the rows'
 */
export function unread(reply, rows, { over = false, joined = false } = {}) {
  const a = squash(reply);
  if (!a) return '';
  // each row's reply text once; the replies after a user message are the ones that follow it, as one
  const own = rows.map((r) => (r.role === 'assistant' && typeof r.text === 'string' ? squash(r.text) : ''));
  const starts = rows.flatMap((r, i) => (r.role === 'user' ? [i] : [])).slice(-TURNS);
  const texts = (starts.length ? starts : [-1]).reverse().map((k) => own.slice(k + 1).join(''));
  const latest = texts[0];
  // the turn's own message is the last one, or (once replies follow it) one of the last few: a follow-up steered into
  // the turn comes after it. With no reply after the last message, an earlier one's replies are another turn's.
  for (const b of latest ? texts : []) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    if (n === a.length) return '';
    // a row cut short ends with "…": what the rows hold stops there
    if (n === b.length || (n === b.length - 1 && b.endsWith('…'))) return past(reply, n);
  }
  if (joined && latest) {
    const q = overlap(a, latest);
    if (q === a.length) return '';
    if (q >= MIN_OVERLAP) return past(reply, q);
  }
  if (!latest) return reply;
  return over ? '' : reply;
}
