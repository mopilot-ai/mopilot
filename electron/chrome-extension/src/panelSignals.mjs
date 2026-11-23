// The two banners MoPilot's harnesses can give a chat above the composer: the usage banner's "approaching" state
// (a usage window is nearly used up: dismissible, the composer stays open) and the refusal card ("Stopped by a safety check": the harness's safety check stopped the chat).
// Main says each in the chat's read (electron/app/chromePanel.cjs: `limitWarning`, a note row with `refusal: true`); PanelThread puts them on #chat as data-* and
// PanelChrome shows them through these. A harness with no such signal gives none, and the banner never shows for it.

/** The banner's words for the two plan windows. Extra usage has no window to warn about, so it has none. */
export const WARNING_TEXT = Object.assign(Object.create(null), {
  '5h': '5-hour limit almost used up',
  '7d': 'Weekly limit almost used up',
});

/** The banner's words when the limit is reached and the harness names no window (the app's own words for it). */
export const LIMIT_REACHED = 'Usage limit reached';

const REACHED_NAME = Object.assign(Object.create(null), { '5h': '5-hour', '7d': 'Weekly' });

/**
 * The banner's words for the limit main says the chat stopped on (`limit` in the chat's read: `{ key, window, resetsAt }`):
 * "{5-hour|Weekly} limit reached · resets {time}" (the weekly time carries the weekday), else the plain "Usage limit reached" when the harness named no
 * window or no reset still to come. The time is in the browser's own zone and language.
 * @param {{ window?: unknown, resetsAt?: unknown } | null | undefined} limit @param {number} now ms
 */
export function reachedText(limit, now) {
  const name = REACHED_NAME[String(limit?.window)];
  const at =
    typeof limit?.resetsAt === 'number' && Number.isFinite(limit.resetsAt) && limit.resetsAt > now ? new Date(limit.resetsAt) : null;
  if (!name || !at) return LIMIT_REACHED;
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${name} limit reached · resets ${limit?.window === '7d' ? `${at.toLocaleDateString([], { weekday: 'long' })} ` : ''}${time}`;
}

/** The refusal card's words: what stopped the chat, that it can happen to ordinary requests, and the two ways on. */
export const REFUSAL = {
  title: 'Stopped by a safety check',
  body: "The agent's safety check stopped this chat. It sometimes stops ordinary requests too. Send a new message to try again, or start a new chat.",
};

/** The longest wait setTimeout takes (a 32-bit count of ms). */
const MAX_WAIT = 2 ** 31 - 1;

/**
 * What the usage banner says of the warning on #chat (`data-warning`, main's `limitWarning` as JSON): its text, the key a dismissal belongs to
 * (the window and its reset, so the next window warns again) and when it stops holding (ms; null when main named no reset). Null when there is
 * none, when it names no window the banner has words for, or when its window has already reset.
 * @param {string | undefined} raw @param {number} now ms
 * @returns {{ key: string, text: string, until: number | null } | null}
 */
export function warningBanner(raw, now) {
  let warning;
  try {
    warning = JSON.parse(raw || 'null');
  } catch {
    return null;
  }
  const text = WARNING_TEXT[String(warning?.window)];
  if (!text) return null;
  const until = Number.isFinite(warning.resetsAt) ? warning.resetsAt : null;
  if (until !== null && until <= now) return null;
  return { key: JSON.stringify([warning.window, until]), text, until };
}

/** How long to wait before the banner for a warning is read again: its reset (a little after, so the window has passed), in a wait setTimeout can take. */
export const expiryWait = (/** @type {number} */ until, /** @type {number} */ now) => Math.min(Math.max(until - now, 0) + 50, MAX_WAIT);

/** The most dismissals a page remembers (a chat's banner key each): the oldest is forgotten first. */
export const MAX_DISMISSED = 64;

/** What the user dismissed, by full key (chat, then the refusal or the window and its reset): coming back to a chat does not bring a dismissed banner back. */
export class Dismissals {
  constructor() {
    /** @type {Set<string>} */
    this.keys = new Set();
  }

  add(/** @type {string | null} */ key) {
    if (key === null) return;
    this.keys.delete(key);
    this.keys.add(key);
    for (const old of this.keys) if (this.keys.size > MAX_DISMISSED) this.keys.delete(old);
  }

  has(/** @type {string | null} */ key) {
    return key !== null && this.keys.has(key);
  }
}

/** The refusal card: shown while the chat is idle and its last row is the refusal; gone when a turn runs, a message is sent, another chat opens, or the X is pressed. */
export class PanelRefusal {
  /** @param {{ document: any }} g @param {(target: any, event: string, fn: () => void) => void} listen */
  constructor(g, listen) {
    this.chat = g.document.getElementById('chat');
    this.root = g.document.getElementById('refusal');
    this.dismissed = new Dismissals();
    this.last = null;
    if (!this.root) return;
    this.root.querySelector('.refusal-title').textContent = REFUSAL.title;
    this.root.querySelector('.refusal-body').textContent = REFUSAL.body;
    listen(g.document.getElementById('refusal-off'), 'click', () => {
      this.dismissed.add(this.last);
      this.update();
    });
  }

  update() {
    if (!this.root) return;
    const chat = this.chat;
    const key = chat.dataset.refusalKey ? JSON.stringify([chat.dataset.chatId, chat.dataset.refusalKey]) : null;
    this.last = key;
    this.root.hidden = chat.hidden || !key || this.dismissed.has(key) || chat.dataset.turn !== 'idle';
  }
}
