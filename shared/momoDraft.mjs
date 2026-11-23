// A message MoMo wrote for the user to review (A3, designs/momo-p5-writes, design/phone-on-orca/momo-drafts-contract.md): the words (to, subject, body) as plain data, checked the same way where MoMo's tool takes them, where the Mac opens a mail app and where the phone does, and the one `mailto:` link that hands them to the user's own mail app. A draft is text shown to the user; nothing in here sends, reaches a network or names a way to.

/** The most text one draft carries: the body, the subject, how many people it names, and one address. */
export const MAX_BODY = 6000;
export const MAX_SUBJECT = 200;
export const MAX_TO = 20;
export const MAX_ADDRESS = 254;
/** The longest `mailto:` link handed to a mail app; a longer draft is copied instead (mail apps cut or refuse more). */
export const MAX_MAILTO = 2000;

/** What a draft's words may be refused for. */
export const CODES = Object.freeze({ BAD_TO: 'bad_to', BAD_SUBJECT: 'bad_subject', BAD_BODY: 'bad_body', TOO_LONG: 'too_long' });

const ADDRESS = /^[^\s@<>(),;:"\\[\]]+@[^\s@<>(),;:"\\[\]]+\.[^\s@<>(),;:"\\[\]]+$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const OTHER_CONTROL = /[\u0000-\u001f\u007f]/;

/** @typedef {{ to: string[], subject: string, body: string }} Draft */
/** @typedef {{ ok: true, draft: Draft } | { ok: false, reason: string, why: string }} Read */

const refuse = (/** @type {string} */ reason, /** @type {string} */ why) => ({ ok: /** @type {const} */ (false), reason, why });
const record = (/** @type {unknown} */ v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : null;

/**
 * A draft read from what was given (MoMo's tool call, a saved note, a phone's row, an edit): the addresses without
 * repeats (none is fine: the user may not know who it is for), the subject on one line, the body with plain line breaks.
 * Anything else, or more than the limits, is refused with a reason (one of CODES) and a short line saying why, never cut.
 * @param {unknown} input @returns {Read}
 */
export function readDraft(input) {
  const o = record(input);
  if (!o) return refuse(CODES.BAD_BODY, 'A draft needs a body.');
  const given = o.to === undefined || o.to === null ? [] : typeof o.to === 'string' ? o.to.split(/[,;]+/) : o.to;
  if (!Array.isArray(given) || given.some((a) => typeof a !== 'string'))
    return refuse(CODES.BAD_TO, 'to must be a list of email addresses.');
  /** @type {string[]} */
  const to = [];
  for (const raw of /** @type {string[]} */ (given)) {
    const a = raw.trim();
    if (!a) continue;
    if (a.length > MAX_ADDRESS || !ADDRESS.test(a)) return refuse(CODES.BAD_TO, `"${a.slice(0, 60)}" is not an email address.`);
    if (!to.some((x) => x.toLowerCase() === a.toLowerCase())) to.push(a);
  }
  if (to.length > MAX_TO) return refuse(CODES.TOO_LONG, `A draft names at most ${MAX_TO} people.`);
  if (o.subject !== undefined && o.subject !== null && typeof o.subject !== 'string')
    return refuse(CODES.BAD_SUBJECT, 'The subject must be text.');
  const subject = String(o.subject ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (OTHER_CONTROL.test(subject)) return refuse(CODES.BAD_SUBJECT, 'The subject has characters a mail header can not hold.');
  if (subject.length > MAX_SUBJECT) return refuse(CODES.TOO_LONG, `The subject is longer than ${MAX_SUBJECT} characters.`);
  if (typeof o.body !== 'string' || !o.body.trim()) return refuse(CODES.BAD_BODY, 'A draft needs a body.');
  const body = o.body.replace(/\r\n?/g, '\n');
  if (CONTROL.test(body)) return refuse(CODES.BAD_BODY, 'The body has characters that are not text.');
  if (body.length > MAX_BODY) return refuse(CODES.TOO_LONG, `The body is longer than ${MAX_BODY} characters.`);
  return { ok: true, draft: { to, subject, body } };
}

/** A draft from a saved note or a phone row's `draft` field, or null when it is not one. @param {unknown} v @returns {Draft | null} */
export function draftOf(v) {
  const r = readDraft(v);
  return r.ok ? r.draft : null;
}

/**
 * The `mailto:` link that opens the user's mail app on the draft, its words percent-encoded, or why there is none: a
 * draft too long for a link is copied instead.
 * @param {Draft} draft @returns {{ ok: true, url: string } | { ok: false, reason: string, why: string }}
 */
export function mailtoOf(draft) {
  const to = draft.to.map((a) => encodeURIComponent(a).replace(/%40/g, '@')).join(',');
  const query = [
    ...(draft.subject ? [`subject=${encodeURIComponent(draft.subject)}`] : []),
    `body=${encodeURIComponent(draft.body.replace(/\n/g, '\r\n'))}`,
  ].join('&');
  const url = `mailto:${to}?${query}`;
  return url.length > MAX_MAILTO ? refuse(CODES.TOO_LONG, 'Too long to open in Mail. Copy it instead.') : { ok: true, url };
}

/** The only kind of link a draft ever opens. */
export const isMailto = (/** @type {unknown} */ url) => typeof url === 'string' && /^mailto:/i.test(url);

/** The one line a draft is in a transcript's text (the Chrome panel and notifications show text, never the body). */
export const draftLine = (/** @type {Draft} */ d) => `Draft · ${d.subject || 'No subject'}`;

/** The recipients as a card lists them: each with what it is (addresses only), and the total for "To · N". */
export function recipientsOf(/** @type {Draft} */ d) {
  return { items: d.to.map((label) => ({ kind: /** @type {const} */ ('email'), label })), count: d.to.length };
}
