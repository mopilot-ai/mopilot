// What a MoMo draft keeps once the user sends it from the card (MoMo's draft card design): the account it goes from, how far the send got (asked, chosen, sent, or not sure), and the reasons a send stops, as plain data both clients read the same way. The Mac and the phone each say the words in their own catalogs; nothing in here names a harness, reaches a network or sends.

/** The one connector tool that sends mail: kind change, so it runs only on the person's own press on the draft, bound to exactly what they were shown (the press is the approval: no second card). */
export const SEND_TOOL = 'send_mail';

/**
 * How far a send got: `asked` (the person pressed Send and the send is starting), `chose` (the press was checked against what was shown), `sent` (the account took it), `unsure` (the app stopped, or the account was cut off, before it was known).
 */
export const STATES = Object.freeze({
  ASKED: 'asked',
  CHOSE: 'chose',
  SENT: 'sent',
  UNSURE: 'unsure',
});

/** Why a send did not start or did not finish; the card says each in one line. */
export const WHY = Object.freeze({
  NOT_ALLOWED: 'not_allowed',
  NO_DRAFT: 'no_draft',
  BUSY: 'busy',
  ALREADY: 'already',
  NO_RECIPIENT: 'no_recipient',
  NO_ACCOUNT: 'no_account',
  LOST: 'lost',
  CHOOSE: 'choose',
  NOT_CONNECTED: 'not_connected',
  RECONNECT: 'reconnect',
  PAUSED: 'paused',
  READ_ONLY: 'read_only',
  DECLINED: 'declined',
  FAILED: 'failed',
});

/** @typedef {{ id: string, label: string, account: string }} From the connector the mail goes from, as the card shows it */
/** @typedef {{ state: 'asked' | 'chose' | 'sent' | 'unsure', from: From, at: number }} Send */

const STATE_SET = new Set(Object.values(STATES));
const short = (/** @type {unknown} */ v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

/** A saved send (a note's `send`, a phone row's), or null when it is not one. @param {unknown} v @returns {Send | null} */
export function readSend(v) {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : null;
  const from = o?.from && typeof o.from === 'object' ? o.from : null;
  if (!o || !from || !STATE_SET.has(o.state) || typeof o.at !== 'number' || !Number.isFinite(o.at)) return null;
  const id = short(from.id, 64);
  if (!id) return null;
  return {
    state: o.state,
    from: { id, label: short(from.label), account: short(from.account) },
    at: o.at,
  };
}

/** The account as the chooser and the lines name it: the address when it has one, else the connector's name. */
export const fromName = (/** @type {From} */ from) => from.account || from.label || from.id;

/**
 * The lines a draft shows once a send began, oldest first, each a code the clients put into words: asked, then chose
 * (the user's yes), then sent; an unsure send says only that it is unsure. Read only: the card has no control then.
 * @param {Send | null} send @returns {('asked' | 'chose' | 'sent' | 'unsure')[]}
 */
export function sendLines(send) {
  if (!send) return [];
  if (send.state === STATES.UNSURE) return [STATES.UNSURE];
  if (send.state === STATES.ASKED) return [STATES.ASKED];
  if (send.state === STATES.CHOSE) return [STATES.ASKED, STATES.CHOSE];
  return [STATES.ASKED, STATES.CHOSE, STATES.SENT];
}

/** Whether the card is still the user's to change: no send began, or the last one went back (a no, a failure). */
export const isOpen = (/** @type {Send | null} */ send) => send === null;
