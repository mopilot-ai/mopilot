// What a MoMo open loop is (#2139 P4, L4): a promise, date or to-do the user said in a MoMo main chat, kept with the user's own words as its quote and a confidence; how a memory pass's loop ops are checked (the quote must be in the user's own messages and in nothing else the chat holds: tool results, MoMo's replies, MoMo's own messages), and how a date the model read from those words becomes an absolute time in the user's time zone.

/** What a loop is about. */
const KINDS = Object.freeze(['promise', 'date', 'todo']);
const CONFIDENCE = Object.freeze(['sure', 'likely']);
const STATES = Object.freeze(['open', 'done', 'dismissed']);
const MAX_TEXT = 200;
const MAX_QUOTE = 300;
const MAX_EVENT = 80;
/** The shortest quote that can tie a loop to what was said. */
const MIN_QUOTE = 4;
/** How far ahead a due date may be from when it was said. */
const MAX_AHEAD_MS = 2 * 365 * 86_400_000;
const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @typedef {{ at: number, trigger: string, key: string }} Nudged one nudge that fired (P4b)
 * @typedef {{ id: string, kind: 'promise' | 'date' | 'todo', text: string, quote: string,
 *   source: { chatId: string, harness: string, turnId: string }, saidAt: number, tz: string,
 *   confidence: 'sure' | 'likely', dueAt?: number, dueDay?: string, event?: string, lastMentionedAt: number,
 *   state: 'open' | 'done' | 'dismissed', closedAt?: number, snoozedUntil?: number, nudged: Nudged[], askedClose?: number }} OpenLoop
 *   dueDay: the day alone ("2030-03-13") when no time was said: the end of that day follows the user's zone now
 * @typedef {{ text: string, at: number, turnId: string }} UserLine one message the user wrote, when, in which turn
 * @typedef {{ user: UserLine[], other: string[] }} Said what a pass read: the user's own messages, and everything else
 */

const str = (/** @type {unknown} */ v, /** @type {number} */ max) =>
  typeof v === 'string' && v.trim() && v.length <= max ? v.trim().replace(/\s+/g, ' ') : null;

/** @param {unknown} v @returns {v is OpenLoop} */
function isLoop(v) {
  const l = /** @type {any} */ (v);
  const num = (/** @type {unknown} */ n) => typeof n === 'number' && Number.isFinite(n);
  return (
    !!l &&
    typeof l === 'object' &&
    typeof l.id === 'string' &&
    !!l.id &&
    KINDS.includes(l.kind) &&
    !!str(l.text, MAX_TEXT) &&
    !!str(l.quote, MAX_QUOTE) &&
    !!l.source &&
    typeof l.source.chatId === 'string' &&
    !!l.source.chatId &&
    typeof l.source.harness === 'string' &&
    typeof l.source.turnId === 'string' &&
    num(l.saidAt) &&
    typeof l.tz === 'string' &&
    CONFIDENCE.includes(l.confidence) &&
    (l.dueAt === undefined || num(l.dueAt)) &&
    (l.dueDay === undefined || (typeof l.dueDay === 'string' && DAY_RE.test(l.dueDay))) &&
    (l.event === undefined || !!str(l.event, MAX_EVENT)) &&
    num(l.lastMentionedAt) &&
    STATES.includes(l.state) &&
    (l.closedAt === undefined || num(l.closedAt)) &&
    (l.snoozedUntil === undefined || num(l.snoozedUntil)) &&
    (l.askedClose === undefined || num(l.askedClose)) &&
    Array.isArray(l.nudged) &&
    l.nudged.every((/** @type {any} */ n) => n && num(n.at) && typeof n.trigger === 'string' && typeof n.key === 'string')
  );
}

/** Text as compared for a quote: case, quotes and runs of whitespace or punctuation ignored. */
const norm = (/** @type {string} */ t) =>
  t
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, '')
    .replace(/[\s\p{P}]+/gu, ' ')
    .trim();

/**
 * The user's message `quote` comes from, or null: it must be in one of the user's own messages and in nothing else the
 * chat holds (a tool result, MoMo's reply or one of MoMo's own messages), so words the user pasted from elsewhere, or a
 * nudge MoMo sent, never become a loop.
 * @param {string} quote @param {Said} said @returns {UserLine | null}
 */
function quotedByUser(quote, said) {
  const q = norm(quote);
  if ([...q.replace(/ /g, '')].length < MIN_QUOTE) return null;
  if (said.other.some((t) => norm(t).includes(q))) return null;
  return said.user.find((u) => norm(u.text).includes(q)) ?? null;
}

/** The offset of `tz` from UTC at `at`, in ms (an unknown zone reads as UTC). */
function zoneOffset(/** @type {number} */ at, /** @type {string} */ tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(at));
  } catch {
    return 0;
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}

/**
 * The absolute time of a wall-clock time in `tz` (a time a daylight-saving change skips lands just after it).
 * @param {{ y: number, mo: number, d: number, h: number, mi: number }} c month 1–12 @param {string} tz
 */
function zonedEpoch({ y, mo, d, h, mi }, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const first = wall - zoneOffset(wall, tz);
  const second = wall - zoneOffset(first, tz);
  return second === first ? first : Math.max(first, second);
}

/**
 * A due date the model read from the user's words ("2030-03-13", or "2030-03-13T15:00"), as an absolute time in the zone
 * the user was in when they said it: a date alone is that day's end. Null when it isn't one, or is before the day it was
 * said or more than two years after.
 * @param {unknown} due @param {string} tz @param {number} saidAt
 */
function dueOf(due, tz, saidAt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(typeof due === 'string' ? due.trim() : '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const timed = m[4] !== undefined;
  const h = timed ? Number(m[4]) : 23;
  const mi = timed ? Number(m[5]) : 59;
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) return null;
  const at = zonedEpoch({ y, mo, d, h, mi }, tz);
  if (at < saidAt - DAY_MS || at > saidAt + MAX_AHEAD_MS) return null;
  return at;
}

/** `at` as the user reads it in `tz`, with its weekday ("Mon 2030-03-11 14:05"), for a pass's prompt. */
function localLabel(/** @type {number} */ at, /** @type {string} */ tz) {
  const shifted = new Date(at + zoneOffset(at, tz));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][shifted.getUTCDay()];
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${day} ${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

/**
 * The loop ops of a pass's reply that may be applied, and why each other one was dropped. An add needs a kind, a short
 * text, a quote from the user's own words (quotedByUser) and a confidence (likely when unsaid); its due date is read in
 * `tz` against when the quoted words were said, and one that can't be read is dropped with the loop kept (no date). A
 * mention or done names an open loop shown to the pass; a done needs the user's words too.
 * @param {unknown[]} ops
 * @param {{ said: Said, tz: string, open: Set<string>, looksSecret: (text: string) => boolean }} o
 */
function checkLoops(ops, { said, tz, open, looksSecret }) {
  /** @type {{ kind: string, text: string, quote: string, line: UserLine, tz: string, confidence: string, dueAt?: number, dueDay?: string, event?: string }[]} */
  const add = [];
  /** @type {string[]} */
  const mention = [];
  /** @type {string[]} */
  const done = [];
  /** @type {{ op: string, reason: string }[]} */
  const dropped = [];
  for (const raw of ops) {
    const o = /** @type {any} */ (raw);
    const op = String(o?.op ?? 'add');
    if (op === 'mention' || op === 'done') {
      if (typeof o.id !== 'string' || !open.has(o.id)) dropped.push({ op, reason: 'not an open loop' });
      else if (op === 'done' && !(typeof o.quote === 'string' && quotedByUser(o.quote, said)))
        dropped.push({ op, reason: 'not in the user’s words' });
      else (op === 'done' ? done : mention).push(o.id);
      continue;
    }
    const text = str(o?.text, MAX_TEXT);
    const quote = str(o?.quote, MAX_QUOTE);
    const kind = KINDS.includes(o?.kind) ? o.kind : null;
    if (op !== 'add' || !text || !quote || !kind) {
      dropped.push({ op, reason: 'not a loop' });
      continue;
    }
    if (looksSecret(text) || looksSecret(quote)) {
      dropped.push({ op, reason: 'looks like a secret' });
      continue;
    }
    const line = quotedByUser(quote, said);
    if (!line) {
      dropped.push({ op, reason: 'not in the user’s words' });
      continue;
    }
    const dueAt = o.due === undefined || o.due === null ? null : dueOf(o.due, tz, line.at);
    const dueDay = dueAt !== null && DAY_RE.test(String(o.due).trim()) ? String(o.due).trim() : null;
    const event = str(o.event, MAX_EVENT);
    add.push({
      kind,
      text,
      quote,
      line,
      tz,
      confidence: o.confidence === 'sure' ? 'sure' : 'likely',
      ...(dueAt !== null ? { dueAt } : {}),
      ...(dueDay ? { dueDay } : {}),
      ...(event ? { event } : {}),
    });
  }
  return { add, mention, done, dropped };
}

module.exports = {
  KINDS,
  STATES,
  MAX_TEXT,
  MAX_QUOTE,
  MAX_EVENT,
  isLoop,
  norm,
  quotedByUser,
  zoneOffset,
  zonedEpoch,
  dueOf,
  localLabel,
  checkLoops,
};
