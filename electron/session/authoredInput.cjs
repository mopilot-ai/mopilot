// An input main sends into a chat that no human wrote (MoMo's routine results, a routine's first message, #2287): it keeps a client id of its own, and the chat's main-only meta `authored` says how every window shows it (who it is from, a short title, what may be shown), so the transcript draws it as its author's, never as the user's words, and never shows its text (instructions for the model).
const { clock } = require('../platform/ports/clock.cjs');
const crypto = require('node:crypto');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');

/**
 * How many such inputs a chat keeps the presentation of: the oldest goes past this (a chat's meta reaches every window,
 * so it stays small). One older than that is shown as the harness has it.
 */
const AUTHORED_KEPT = 200;
/** Who an input can be from: MoMo, or MoPilot itself (a review's findings applied without a click). */
const AUTHORS = Object.freeze(['momo', 'mopilot']);
const TITLE_MAX = 200;
/** a routine's result is at most 600 characters (onePara); a goal 600 */
const BODY_MAX = 1200;

/**
 * The item to send, its presentation saved first: one whose presentation can't be saved is not made, so its text never
 * shows as the user's.
 * @param {{ record: (id: string) => { meta?: any } | null | undefined, patchMeta: (id: string, patch: object) => boolean }} chats
 * @param {string} chatId
 * @param {string} text what the model is sent
 * @param {{ by: string, title: string, body?: string | null }} show what windows show in its place
 * @param {number} [now]
 * @returns {{ id: string, authored: { id: string }, text: string, attachments: never[], opts: { human: false } }}
 */
function authoredInput(chats, chatId, text, show, now = clock.now()) {
  const title = typeof show?.title === 'string' ? show.title.trim() : '';
  if (!AUTHORS.includes(show?.by) || !title) throw new Error('An authored input needs its author and a title');
  const id = crypto.randomUUID();
  const prev = chats.record(chatId)?.meta?.authored;
  const kept = /** @type {[string, { at: number }][]} */ (
    Object.entries(isJsonRecord(prev) ? prev : {}).filter(([, v]) => isJsonRecord(v) && typeof v.at === 'number')
  )
    .sort(([, a], [, b]) => a.at - b.at)
    .slice(-(AUTHORED_KEPT - 1));
  const body = typeof show.body === 'string' ? show.body.trim() : '';
  const entry = { by: show.by, title: title.slice(0, TITLE_MAX), ...(body ? { body: body.slice(0, BODY_MAX) } : {}), at: now };
  // patchMeta-changes: the entry has a fresh id, so the meta always changes
  if (!chats.patchMeta(chatId, { authored: { ...Object.fromEntries(kept), [id]: entry } }))
    throw new Error('Couldn’t save how the chat shows this message');
  return { id, authored: { id }, text, attachments: [], opts: { human: false } };
}

/** The mark at the start of MoMo's own inputs. */
const { MODEL_MARK: AUTHORED_MARK } = require('../../shared/modelFraming.mjs');

/**
 * Whether a user message's text is one main sent that no human wrote, by the mark every such input of MoMo's starts with
 * ("[Routine result, not from the user] …"): what a harness's saved history keeps when the client id it was sent with is
 * gone, so MoMo never reads its own message as the user's words.
 */
const isAuthoredText = (/** @type {unknown} */ text) => typeof text === 'string' && AUTHORED_MARK.test(text);

/**
 * The item a service sends: `make`'s (main's authoredInput over its chats, which records how it is shown), or for a
 * service made without one (a unit test) the same input with no presentation.
 * @param {((chatId: string, text: string, show: { by: string, title: string, body?: string | null }) => object) | null | undefined} make
 * @param {string} chatId @param {string} text @param {{ by: string, title: string, body?: string | null }} show
 */
const authoredOr = (make, chatId, text, show) => (make ? make(chatId, text, show) : { text, attachments: [], opts: { human: false } });

module.exports = { authoredInput, authoredOr, isAuthoredText, AUTHORED_MARK, AUTHORED_KEPT, AUTHORS };
