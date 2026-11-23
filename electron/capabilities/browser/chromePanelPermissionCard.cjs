// The wording and shortcuts of the panel's site permission card: a heading, Allow once / Decline / Always allow on this site, and Enter, Esc, Cmd+Enter.
//
// A choice's `shortcut` is a hint and a key the panel binds: 'enter', 'escape' or 'mod-enter' (the first card only, never while the user types).
const HEADING = 'MoPilot needs your OK';
const NOTE = 'MoPilot asks you first before it buys anything, creates an account, or gets past a CAPTCHA.';

/** The card's own fields: a heading above the question and a reminder under the choices. */
const FRAME = Object.freeze({ heading: HEADING, note: NOTE });

const ALLOW_ACTION = Object.freeze({ key: 'once', label: 'Allow once', shortcut: 'enter' });
const DECLINE = Object.freeze({ key: 'deny', label: 'Decline', deny: true, shortcut: 'escape' });
/** A standing grant for the site: the label says what it covers. */
const alwaysFor = (/** @type {string} */ key, /** @type {string} */ label) => ({ key, label, shortcut: 'mod-enter' });

module.exports = { FRAME, ALLOW_ACTION, DECLINE, alwaysFor };
