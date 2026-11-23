// What MoMo's tools tell the model when the sentinel refuses a call or an action ends (#2139): short, honest texts that say what is known and no more (an accepted message is not a delivered one, an uncertain outcome is never retried), and what to do next. An action names its receipt and its failure detail by key from the sets here; its own text never reaches the model or the audit log.
/** @typedef {{ source?: string, kind?: string }} About the source's display name; kind 'read' says "read", anything else "sent" */

const nothing = (/** @type {About} */ a) => (a.kind === 'read' ? 'nothing was read' : 'nothing was sent');

/** @type {Readonly<Record<string, (a: About) => string>>} */
const REFUSALS = Object.freeze({
  'not-allowed': () => "MoMo isn't available on this account, so nothing ran.",
  invalid: () => "This call couldn't be checked, so nothing ran.",
  blocked: (a) => `${a.source} is blocked for MoMo, so nothing ran. Don't try another way; tell the user.`,
  'read-only': (a) => `${a.source} is read only for MoMo, so nothing was changed. Tell the user if it needs changing.`,
  'no-recipients': (a) => `This reaches people but names none, so ${nothing(a)}. Ask the user who it is for, then try again.`,
  'unreadable-recipients': (a) => `Who this reaches couldn't be read, so ${nothing(a)}. Use plain addresses or names, then try again.`,
  denied: (a) => `The user declined this, so ${nothing(a)}. Don't retry it; ask what they'd like instead.`,
  'deny-always': (a) => `The user always declines this exact action, so ${nothing(a)}. Don't retry it.`,
  'no-answer': (a) => `Nobody answered the approval, so ${nothing(a)}. Ask the user before trying again.`,
  audit: (a) => `MoMo's audit log can't be written on this Mac, so ${nothing(a)}. Tell the user.`,
  storage: (a) => `MoMo can't save what it is about to do on this Mac right now, so ${nothing(a)}. Tell the user.`,
});

const RESULTS = Object.freeze({
  done: 'Done.',
  'not sent': 'Nothing was sent.',
  uncertain: "This may or may not have gone through. Don't retry it; tell the user so they can check.",
});

/** Receipts an action can name instead of plain "Done.", for what it can and can't confirm. */
const RECEIPTS = Object.freeze({
  mailAccepted: "Mail accepted this message; delivery can't be confirmed.",
  messageQueued: "The message is queued to send; it hasn't been sent yet.",
  saved: 'Saved.',
  eventAdded: 'Added to Calendar.',
  reminderAdded: 'Reminder added.',
  reminderDone: 'Marked done.',
  undone: 'Undone.',
});

/** Why nothing was sent, as an action can name it. */
const DETAILS = Object.freeze({
  addressRefused: 'The mail server refused the address.',
  notConnected: "The account isn't connected; ask the user to connect it.",
  tooLarge: 'It was too large to send.',
  offline: 'This Mac is offline.',
  accessChanged: 'Access to the source changed while it waited, so it was left alone.',
  notGranted: 'macOS access to it was turned off.',
  helperOld: 'The macOS helper is too old to write to it.',
  readOnlyTarget: 'That calendar or list is read-only.',
  noSuchTarget: 'No calendar, list or item has that name.',
  changedSince: 'It was changed or removed since, so it was left alone.',
});

/** Said after the result when its outcome couldn't be written to the audit log. */
const UNRECORDED = "MoMo couldn't record this in its audit log; tell the user.";

/** The text for a refused call; an unknown reason reads as one that couldn't be checked. */
function refusalText(/** @type {string} */ reason, /** @type {About} */ about = {}) {
  const t = REFUSALS[reason] ?? REFUSALS.invalid;
  return t({ source: about.source || 'This source', kind: about.kind });
}

const known = (/** @type {Record<string, string>} */ set, /** @type {unknown} */ key) =>
  typeof key === 'string' && Object.hasOwn(set, key) ? set[key] : undefined;

/**
 * The text for how an action ended: a known receipt replaces "Done." only when it is done, a known detail follows "Nothing
 * was sent.", and an outcome that wasn't recorded says so.
 * @param {string} result
 * @param {{ receipt?: string, detail?: string, recorded?: boolean }} [o] receipt and detail: keys of RECEIPTS and DETAILS
 */
function resultText(result, { receipt, detail, recorded = true } = {}) {
  let text;
  if (result === 'done') text = known(RECEIPTS, receipt) ?? RESULTS.done;
  else if (result === 'not sent') text = [RESULTS['not sent'], known(DETAILS, detail)].filter(Boolean).join(' ');
  else text = RESULTS.uncertain;
  return recorded ? text : `${text} ${UNRECORDED}`;
}

module.exports = { REFUSALS, RESULTS, RECEIPTS, DETAILS, UNRECORDED, refusalText, resultText, known };
