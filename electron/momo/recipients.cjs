// Who a MoMo change reaches (#4649 A4): the recipients of a send or write read from its arguments (to, cc, bcc, attendees, channels...), whether the tool can reach people at all, and the card's list of them; a tool that reaches people with no readable recipient is blocked, never allowed with the list hidden.
const MAX_TEXT = 200;
/** No call names more people than this; a longer list can't be shown or checked, so it is unreadable. */
const MAX_RECIPIENTS = 500;
const MAX_DEPTH = 2;

/** Argument names (lower-case letters and digits only) whose values are the people or places a call reaches. */
const FIELDS = new Set([
  'to',
  'cc',
  'bcc',
  'recipient',
  'recipients',
  'torecipients',
  'ccrecipients',
  'bccrecipients',
  'recipientemail',
  'recipientemails',
  'attendee',
  'attendees',
  'invitee',
  'invitees',
  'participant',
  'participants',
  'guest',
  'guests',
  'sharewith',
  'sharedwith',
  'email',
  'emails',
  'emailaddress',
  'emailaddresses',
  'phone',
  'phonenumber',
  'channel',
  'channels',
  'channelid',
  'channelname',
  'chatid',
  'user',
  'users',
  'userid',
  'userids',
]);
/** Words in a tool's name that make it a send. */
const VERBS = new Set([
  'send',
  'reply',
  'forward',
  'invite',
  'share',
  'post',
  'message',
  'notify',
  'publish',
  'dm',
  'email',
  'mail',
  'broadcast',
  'tweet',
]);
/** An object recipient's own name for itself, best first (compared as `squash` writes a key). */
const NAMES = ['email', 'emailaddress', 'address', 'username', 'handle', 'displayname', 'name', 'label', 'id'];

const squash = (/** @type {string} */ k) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
const wordsOf = (/** @type {string} */ name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);

/** @param {unknown} v @param {number} depth @returns {string[] | null} the recipients in a value (none for an empty one), or null when it can't be read */
function parse(v, depth = 0) {
  if (v === undefined || v === null) return [];
  if (typeof v === 'number') return Number.isFinite(v) ? [String(v)] : null;
  if (typeof v === 'string') {
    const parts = v
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.every((s) => s.length <= MAX_TEXT) ? parts : null;
  }
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v) {
      const r = parse(x, depth + 1);
      if (!r) return null;
      out.push(...r);
    }
    return out;
  }
  if (typeof v !== 'object') return null;
  const o = /** @type {Record<string, unknown>} */ (v);
  const named = NAMES.map((n) => Object.keys(o).find((k) => squash(k) === n));
  const key = named.find((k) => k && typeof o[k] === 'string' && /** @type {string} */ (o[k]).trim());
  return key ? parse(o[key], depth + 1) : null;
}

/**
 * The recipients a change's arguments name, and whether the tool can reach people: by its name (a send), or by naming any.
 * @param {string} tool @param {unknown} args the call's own arguments @param {string} kind
 * @returns {{ reaches: boolean, recipients: string[], unreadable: boolean }}
 */
function recipientsOf(tool, args, kind) {
  const none = {
    reaches: false,
    recipients: /** @type {string[]} */ ([]),
    unreadable: false,
  };
  if (kind !== 'change') return none;
  const found = [];
  let unreadable = false;
  const a = args && typeof args === 'object' && !Array.isArray(args) ? /** @type {Record<string, unknown>} */ (args) : {};
  for (const [k, v] of Object.entries(a)) {
    if (!FIELDS.has(squash(k))) continue;
    const r = parse(v);
    if (r) found.push(...r);
    else unreadable = true;
  }
  const recipients = [...new Set(found.map((s) => s.toLowerCase()))].sort();
  const tooMany = recipients.length > MAX_RECIPIENTS;
  const reaches = wordsOf(tool).some((w) => VERBS.has(w)) || recipients.length > 0 || unreadable;
  return {
    reaches,
    recipients: tooMany ? [] : recipients,
    unreadable: unreadable || tooMany,
  };
}

/** Why a call that reaches people may not be allowed: '' when it may be asked about, else the card's reason. */
function blockOf(/** @type {{ kind?: string, reaches?: boolean }} */ call, /** @type {{ recipients: string[], unknown: boolean }} */ dest) {
  if (call.reaches !== true || call.kind !== 'change') return '';
  if (dest.unknown) return 'unreadable-recipients';
  return dest.recipients.length ? '' : 'no-recipients';
}

/** What a recipient is, from its label: an app or page MoMo acts on, an address, a channel, or a person. */
function kindOf(/** @type {string} */ label) {
  if (/^the (page|app) /.test(label)) return 'app';
  if (/^[^\s@]+@[^\s@]+$/.test(label)) return 'email';
  if (/^[#@]/.test(label)) return 'channel';
  return 'person';
}

module.exports = {
  recipientsOf,
  blockOf,
  kindOf,
  FIELDS,
  VERBS,
  MAX_RECIPIENTS,
};
