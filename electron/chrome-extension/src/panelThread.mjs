// The side panel's open chat (sidePanel.mjs): its rows as MoPilot reads them back, the reply streaming in until a read of the chat holds it, the requests waiting for the user, its turn, and what it runs on.
//
// MoPilot is the source of every row (electron/app/chromePanel.cjs read). The streamed text is only a preview of
// the reply being written, kept until a read's rows hold it (panelPreview.mjs). A burst of "changed" updates is one
// read; one more arriving during a read reads again once it ends. A message just sent shows until a read has it (its
// harness may not have written it yet). The streamed reply is drawn as the rows draw a reply, Markdown and Copy row's
// room included, so the read that holds it moves nothing; Retry (panelRetry.mjs) sits under the last reply. A request's choices are MoPilot's
// (electron/capabilities/browser/chromePanelCards.cjs): the panel sends back the key of the one picked. Replies show
// their Markdown (panelMarkdown.mjs); text from MoPilot or a page only ever goes in as text.
import { markdown } from './panelMarkdown.mjs';
import { named } from './panelMention.mjs';
import { PanelCards } from './panelCards.mjs';
import { unread } from './panelPreview.mjs';
import { messageTools } from './panelMessage.mjs';
import { stepElement, workedFor } from './panelStep.mjs';
import { reconcile } from './panelNodes.mjs';
import { mark, windowed } from './panelMotion.mjs';
import { CONNECTION_LOST } from './panelLink.mjs';
import { reachedText } from './panelSignals.mjs';
import { RetrySlot, mayRetry, retryTarget } from './panelRetry.mjs';

/** How a chat's turn reads under its rows. */
export const PROGRESS = Object.assign(Object.create(null), {
  running: { tone: 'wait', text: 'Working…' },
  waiting: { tone: 'wait', text: 'Waiting for you' },
  idle: { tone: 'ok', text: 'Done' },
  // the turn stopped on the account's usage limit (its note is the last row): not a finished one
  limit: { tone: 'error', text: 'Limit reached' },
  // the harness's safety check stopped the chat (its note is the last row)
  refusal: { tone: 'error', text: 'Stopped by a safety check' },
  // the user stopped the turn (its last history turn is `interrupted`): muted, nothing went wrong
  stopped: { tone: 'off', text: 'Stopped' },
  // the turn failed (its last history turn is `failed`)
  failed: { tone: 'error', text: 'Failed' },
});

/** How an idle chat's last history turn ended (shared/*Translate.mjs on every harness) as the PROGRESS line that says so. */
const ENDED_AS = Object.assign(Object.create(null), { interrupted: 'stopped', failed: 'failed' });

/** The lines an idle chat keeps showing until a turn runs: how its last turn ended (an update that only says idle brings no "Done" back). */
const ENDINGS = new Set(['limit', 'refusal', 'stopped', 'failed']);

/**
 * When a running turn began (ms), from the chat's last history turn as main read it; '' when main can't say (the turn has
 * no row yet). Only for a panel that opened the chat mid-turn: one that saw the turn begin counts from there.
 */
const startOf = (/** @type {any} */ r, /** @type {boolean} */ joined) =>
  joined && r.state === 'running' && Number.isFinite(r.turn?.startedAt) && r.turn.startedAt > 0
    ? String(Math.round(r.turn.startedAt * 1000))
    : '';

/** The PROGRESS line of a chat that is idle: its limit or refusal note last, else how its last history turn ended; null for a plain "Done". */
const endedAs = (
  /** @type {{ role: string, limit?: boolean, refusal?: boolean }[]} */ rows,
  /** @type {{ status?: string } | null | undefined} */ turn,
) => (rows.at(-1)?.limit === true ? 'limit' : rows.at(-1)?.refusal === true ? 'refusal' : (ENDED_AS[String(turn?.status)] ?? null));

/** How many of the rows are the message `text` (the tab's line may follow it in its row). */
const copies = (/** @type {{ role: string, text: string }[]} */ rows, /** @type {string} */ text) =>
  rows.filter((r) => r.role === 'user' && r.text.startsWith(text)).length;

/**
 * Whether a message sent from here has no row yet: its harness writes it once, so it is in the rows when they hold more
 * copies of it than they did when it was sent (`seen`): a Retry, or "yes" twice, repeats a message the rows already
 * hold. With older rows left out (`omitted`) a count can't say, and any copy is it.
 */
const unwritten = (/** @type {any[]} */ rows, /** @type {string} */ text, /** @type {number} */ seen, /** @type {boolean} */ omitted) =>
  copies(rows, text) <= (omitted ? 0 : seen);

/** Each row's look: a message, a reply, a note that the chat moved to another account, else a step. */
const ROW_CLASS = Object.assign(Object.create(null), { user: 'you', assistant: 'reply', note: 'note' });

/** A page's site as a tab label names it: its host, or the address as it is when it is not one. */
const siteOf = (/** @type {string} */ url) => (URL.canParse(url) ? new URL(url).host : url);

/** How long a chat's first read may take before the panel offers Try again. */
export const LOAD_MS = 15_000;
/** A streamed reply longer than this many characters is redrawn on a timer, not on every word. */
export const BIG_REPLY = 20_000;
export const LIVE_MS = 100;

export class PanelThread {
  /**
   * @param {{ document: any, request: (method: string, params?: object) => Promise<any>, onError: (text: string, retry?: () => unknown) => void,
   *           onOpen: (chatId: string) => void, onTurn?: () => void, onRetry?: (text: string) => void,
   *           timers?: { setTimeout: (f: () => void, ms: number) => any, clearTimeout: (t: any) => void } }} o
   *   request: one panel request to MoPilot (rejects with the line to show); onOpen: the chat in MoPilot;
   *   timers: the window's
   */
  constructor(o) {
    this.o = o;
    this.timers = o.timers ?? globalThis;
    /** the open chat's rows have come once */
    this.loaded = true;
    /** @type {any} the first read's watchdog */
    this.watchdog = null;
    this.doc = o.document;
    this.cardView = new PanelCards({ ...o, container: this.$('cards'), onAnswered: () => this.read() });
    /** @type {string | null} */
    this.chatId = null;
    this.reading = false;
    this.again = false;
    /** all the text the chat's turn streamed; the preview (live) is what of it no read has as rows yet */
    this.reply = '';
    this.live = '';
    /** @type {string[]} messages sent from the panel that no read has shown yet */
    this.sent = [];
    /** @type {number[]} for each, the copies of it the rows held when it was sent (or queued before it) */
    this.seen = [];
    this.openingSeen = 0;
    /** @type {string | null} the message from here that started the running turn */
    this.opening = null;
    /** @type {{ role: string, text: string, tab?: string, runId?: string }[]} */
    this.rows = [];
    /** @type {Set<string>} the runs of steps the user opened, each by the row before it and its first step */
    this.openSteps = new Set();
    this.openMessages = new Set();
    this.openDetails = new Set();
    this.rowViews = new Map();
    this.groupViews = new Map();
    this.nextGroups = new Map();
    this.omitted = false;
    /** @type {any[]} the requests waiting for the user, as MoPilot shows them */
    this.cards = [];
    this.state = 'idle';
    /** the key of the PROGRESS line shown: the state, or how an idle chat's last turn ended ('limit', 'stopped', 'failed') */
    this.shown = 'idle';
    /** the turn as its updates said (a read only tells how it is): a reply of its own starts when it runs after idle */
    this.phase = 'idle';
    /** the panel opened the chat while its turn ran: the reply it has may start mid-way through the rows' */
    this.joined = false;
    this.$('load-again').addEventListener('click', () => this.tryAgain());
    /** the Retry under the last reply, and the live reply as last drawn */
    this.retry = new RetrySlot(this.doc);
    this.painted = '';
    /** @type {any} the pending redraw of a long reply */
    this.paintTimer = null;
    // Retry sends the message again only while idle and with none like it already queued (a double click is one send)
    this.retry.button.addEventListener('click', () => {
      const text = this.retry.button.dataset.panelRetry;
      if (mayRetry(this.state, this.sent, text)) this.o.onRetry?.(text);
    });
  }

  /** Try again: the first read's spinner returns (Try again and the error banner's Retry both come here), then the chat is read. */
  tryAgain() {
    if (!this.loaded) this.loading('spin');
    return this.read();
  }

  $(/** @type {string} */ id) {
    return this.doc.getElementById(id);
  }

  /** Tells the page when the running turn began (ms; '' when unknown): the elapsed counter counts from it (panelChrome.mjs). */
  turnStart(/** @type {string} */ ms) {
    const chat = this.$('chat');
    if (chat) chat.dataset.turnStart = ms;
  }

  /** Shows a chat: what is known at once (the message just sent), then its rows from MoPilot. */
  open(/** @type {string} */ chatId, /** @type {{ sent?: string, state?: string }} */ o = {}) {
    this.chatId = chatId;
    this.$('chat').dataset.chatId = chatId;
    this.$('chat').dataset.limitKey = '';
    this.$('chat').dataset.limitText = '';
    this.$('chat').dataset.warning = '';
    this.turnStart('');
    this.reply = '';
    this.live = '';
    this.cards = [];
    this.openSteps = new Set();
    this.openMessages = new Set();
    this.openDetails = new Set();
    this.rowViews = new Map();
    this.groupViews = new Map();
    this.sent = o.sent ? [o.sent] : [];
    this.seen = o.sent ? [0] : [];
    this.opening = o.sent ?? null;
    this.openingSeen = 0;
    this.render([], false);
    // another chat's "Limit reached", "Stopped" or "Failed" is not this one's: its first read says how this one ended
    this.turn(o.state ?? (o.sent ? 'running' : 'idle'), true, null);
    // one opened as it runs is followed from where it is
    this.joined = !o.sent;
    this.$('meta').textContent = '';
    // a spinner until the first read lands; a read that takes too long offers Try again
    this.loaded = false;
    this.loading('spin');
    return this.read();
  }

  /** The first read's line: a spinner, Try again, or nothing once the rows are in. */
  loading(/** @type {'spin' | 'failed' | null} */ what) {
    this.$('loading').hidden = what !== 'spin';
    this.$('load-error').hidden = what !== 'failed';
    this.timers.clearTimeout(this.watchdog);
    this.watchdog = null;
    if (what !== 'spin') return;
    const chatId = this.chatId;
    this.watchdog = this.timers.setTimeout(() => {
      if (this.chatId === chatId && !this.loaded) this.loading('failed');
    }, LOAD_MS);
  }

  /** No chat open (New chat). */
  close() {
    this.chatId = null;
    delete this.$('chat').dataset.chatId;
    this.$('chat').dataset.limitKey = '';
    this.$('chat').dataset.limitText = '';
    this.$('chat').dataset.warning = '';
    this.turnStart('');
    this.openSteps = new Set();
    this.openMessages = new Set();
    this.openDetails = new Set();
    this.rowViews = new Map();
    this.groupViews = new Map();
    this.loaded = true;
    this.loading(null);
    this.opening = null;
    this.reply = '';
    this.live = '';
    this.sent = [];
    this.seen = [];
    this.cards = [];
    this.render([], false);
  }

  /** A follow-up as it is sent: shown at once, its turn running. */
  sending(/** @type {string} */ text) {
    // the copies of it the rows hold now, and those sent before it that none holds yet: it is written when they hold more
    const seen = copies(this.rows, text) + this.sent.filter((t) => t === text).length;
    this.sent.push(text);
    this.seen.push(seen);
    // one sent while the chat is idle starts a turn; one sent while it runs follows the reply under way
    if (this.phase === 'idle') {
      this.opening = text;
      this.openingSeen = seen;
    }
    this.turn('running');
    this.render(this.rows, this.omitted);
  }

  /** MoPilot refused that follow-up: it goes again (its text back in the box is the page's). */
  unsent(/** @type {string} */ text) {
    const i = this.sent.lastIndexOf(text);
    this.sent = this.sent.filter((_t, k) => k !== i);
    this.seen = this.seen.filter((_n, k) => k !== i);
    this.render(this.rows, this.omitted);
  }

  /** Reads the chat's rows again; one more change during a read reads again after it. */
  async read() {
    const chatId = this.chatId;
    if (!chatId) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    try {
      const r = await this.o.request('read', { chatId });
      // another chat opened meanwhile: this answer is not its
      if (this.chatId !== chatId) return;
      // the usage limit the chat stopped on (main's `limit`: its episode, the window and its reset); none when it did not stop on one
      this.$('chat').dataset.limitKey = r.limit?.key ?? '';
      this.$('chat').dataset.limitText = r.limit?.key ? reachedText(r.limit, Date.now()) : '';
      // the harness's warning that a usage window is nearly used up (panelSignals.mjs); none when it gave none
      this.$('chat').dataset.warning = r.limitWarning ? JSON.stringify(r.limitWarning) : '';
      // the running turn's own start: the elapsed counter counts from it (panelChrome.mjs)
      this.turnStart(startOf(r, this.joined));
      // the turn's reply shows past what the rows hold (panelPreview.mjs), with what streamed while the read was out
      const rows = Array.isArray(r.rows) ? r.rows : [];
      // over as its update said too: a read that answers late may say idle while the next turn runs
      const over = r.state === 'idle' && this.phase === 'idle';
      // while the turn runs and its message from here isn't in the rows, they end with the turn before: none of it
      // while the message that started the turn isn't in the rows, they end with the turn before: none of the reply
      const before = !over && !!this.opening && unwritten(rows, this.opening, this.openingSeen, !!r.omitted);
      this.live = before ? this.reply : unread(this.reply, rows, { over, joined: this.joined });
      this.cards = Array.isArray(r.approvals) ? r.approvals : [];
      this.render(rows, !!r.omitted);
      // the model is the menu's (panelMenus.mjs)
      // the harness and the account its turns run on now ("Claude Code · a@b.com")
      this.$('meta').textContent = [r.harness, r.account].filter(Boolean).join(' · ');
      // an idle chat says how its last turn ended: on its limit (the note is the last row), stopped by the user, or failed
      // a read that says idle before the message just sent from here is in its rows is older than the send: the turn had not begun (it must not bring back the last turn's ending)
      if (r.state && !(r.state === 'idle' && this.sent.length))
        this.turn(r.state, false, r.state === 'idle' ? endedAs(rows, r.turn) : null);
      this.loaded = true;
      this.loading(null);
    } catch (e) {
      // a read the transport lost offers Retry on the banner, the same path as Try again
      this.o.onError(
        String(/** @type {Error} */ (e).message),
        /** @type {any} */ (e)?.code === CONNECTION_LOST ? () => this.tryAgain() : undefined,
      );
      // a first read that failed offers Try again at once
      if (!this.loaded && this.chatId === chatId) this.loading('failed');
    } finally {
      this.reading = false;
      // asked again meanwhile, or another chat opened while this read was out: read the chat open now
      const again = this.again || this.chatId !== chatId;
      this.again = false;
      if (again) void this.read();
    }
  }

  /** The reply's text as it streams, shown until a read of the chat holds it. */
  delta(/** @type {string} */ text) {
    this.reply += text;
    this.live += text;
    // drawing takes as long as the reply is, so a long one is redrawn at most every LIVE_MS, the text catching up with it
    if (this.live.length <= BIG_REPLY) return this.showLive();
    this.paintTimer ??= this.timers.setTimeout(() => {
      this.paintTimer = null;
      this.showLive();
    }, LIVE_MS);
  }

  /** A turn of its own: its reply starts from nothing, from its start. */
  newReply() {
    // the start a read gave is the turn before's
    this.turnStart('');
    this.reply = '';
    this.live = '';
    this.joined = false;
    this.showLive();
  }

  /** The streamed reply as a row draws one: Markdown, with the Copy row's room (the stylesheet hides its button until the read holds it). */
  showLive() {
    const el = this.$('live');
    if (this.painted !== this.live) {
      this.painted = this.live;
      el.replaceChildren(...markdown(this.doc, this.live));
      messageTools(this.doc, el, { role: 'assistant', text: this.live }, 'live', this.openMessages);
    }
    el.hidden = !this.live;
  }

  /**
   * The chat's turn moved on: its line, and its rows again once it ends. One that starts after the last ended (an
   * update, or a message sent from here; a read only says how it is) streams a reply of its own. An idle chat that ended
   * on its account's limit, stopped or failed (a read said so: `ended`) keeps saying it until a turn runs.
   */
  turn(/** @type {string} */ state, starts = true, ended = state === 'idle' && ENDINGS.has(this.shown) ? this.shown : null) {
    if (starts) {
      if (state === 'running' && this.phase === 'idle') this.newReply();
      this.phase = state;
      // a read never says a turn started, nor ended: one that answers late may say idle while the next one runs
    } else if (state !== 'idle') this.phase = state;
    const shown = ended ?? state;
    const changed = this.shown !== shown;
    this.state = state;
    this.shown = shown;
    // the stylesheet shimmers the working line and the running step while it runs, and windows the last run's steps while it runs or waits
    const chat = this.$('chat');
    if (chat) chat.dataset.turn = state;
    this.retry.button.disabled = state !== 'idle';
    // the start a read gave belongs to the turn that ended
    if (state === 'idle') this.turnStart('');
    this.o.onTurn?.();
    const p = PROGRESS[shown] ?? PROGRESS.running;
    this.$('progress-dot').className = `dot ${p.tone}`;
    if (changed || !this.$('progress-text').textContent) this.$('progress-text').textContent = p.text;
  }

  /** The rows, each as text; the live reply after them. */
  render(
    /** @type {{ role: string, text: string, tab?: string, runId?: string, id?: string, state?: string }[]} */ rows,
    /** @type {boolean} */ omitted,
  ) {
    const doc = this.doc;
    this.rows = rows;
    this.omitted = omitted;
    const waiting = this.sent.map((t, i) => unwritten(rows, t, this.seen[i], omitted));
    this.sent = this.sent.filter((_t, i) => waiting[i]);
    this.seen = this.seen.filter((_n, i) => waiting[i]);
    rows = [...rows, ...this.sent.map((text) => ({ role: 'user', text }))];
    // the refusal card is for a chat whose last row is the refusal: a message sent from here after it is the last row, so the card goes at once
    const refused = /** @type {any} */ (rows.at(-1))?.refusal === true ? /** @type {any} */ (rows.at(-1)) : null;
    const chat = this.$('chat');
    if (chat) chat.dataset.refusalKey = refused ? (refused.id ?? refused.text) : '';
    const out = [];
    if (omitted) {
      const p = doc.createElement('p');
      p.className = 'omitted';
      p.textContent = 'Earlier messages are in MoPilot.';
      out.push(p);
    }
    /** @type {any[]} the steps in a row so far; the row before them, which with their first step names the run */
    let run = [];
    let before = '';
    let runKey = '';
    const occurrences = new Map();
    const nextViews = new Map();
    this.nextGroups = new Map();
    const endRun = (last = false) => {
      // a turn that finished in one run of steps says how long it worked, even with one step
      out.push(...(run.length > 1 || run[0]?.dataset.workedMs ? [this.steps(run, runKey, last)] : run));
      run = [];
    };
    const target = retryTarget(rows);
    /** @type {any} the element of the reply Retry goes under */
    let host = null;
    rows.forEach((row, index) => {
      const messageKey = row.id ?? JSON.stringify([row.role, row.text, occurrences.get(row.text) ?? 0]);
      occurrences.set(row.text, (occurrences.get(row.text) ?? 0) + 1);
      const signature = JSON.stringify(row);
      const previous = this.rowViews.get(messageKey);
      // what a step reads as, and in which state
      const line = `${row.state ?? ''}\n${row.text}`;
      let el = previous?.signature === signature ? previous.el : null;
      if (!el) {
        el = row.role === 'step' ? stepElement(doc, row, messageKey, this.openDetails) : doc.createElement('div');
        el.className = ROW_CLASS[row.role] ?? 'step';
        if (row.role === 'assistant') el.append(...markdown(doc, row.text));
        else if (row.role !== 'step') el.textContent = row.role === 'user' ? named(row.text) : row.text;
        // a step that comes while the turn runs enters; one whose line changed (its state) fades its new line in; one that only
        // gained a detail or a screenshot stays still. Not the rows a read brings when the chat opens, nor those of a turn that is over
        else if (this.loaded && this.state !== 'idle' && previous?.line !== line) mark(el, previous ? 'fade' : 'enter', this.timers);
        messageTools(doc, el, row, messageKey, this.openMessages);
        if (row.role === 'user' && row.tab) el.append(this.tabLabel(row.tab));
      }
      nextViews.set(messageKey, { signature, el, line });
      if (index === target?.index) host = el;
      if (el.className !== 'step') {
        endRun();
        out.push(el);
        before = `${row.role}\n${row.text}`;
        return;
      }
      if (!run.length) {
        const content = `${before}\n${row.text}`;
        const occurrence = occurrences.get(content) ?? 0;
        occurrences.set(content, occurrence + 1);
        runKey = row.runId ?? JSON.stringify([content, occurrence]);
      }
      run.push(el);
    });
    // the run at the end of the thread is the one that goes on while the turn does
    endRun(true);
    this.rowViews = nextViews;
    this.groupViews = this.nextGroups;
    reconcile(this.$('rows'), out);
    this.retry.place(host, target?.text, this.state !== 'idle');
    this.showLive();
    this.cardView.render(this.chatId, this.cards);
  }

  /**
   * Steps in a row as one line, as the app folds a turn's work: how many and the latest, the steps under it when opened.
   * It stays open or shut across reads, named by the row before it and its first step: rows read later, or older ones
   * left out at the top, don't move it. The run at the end of the thread (`last`) is the one a running turn adds to: its
   * fold shows its last three steps beside the summary while the turn runs (panelMotion.mjs).
   */
  steps(/** @type {any[]} */ els, /** @type {string} */ at, last = false) {
    const doc = this.doc;
    let box = this.groupViews.get(at);
    if (!box) {
      box = doc.createElement('details');
      box.className = 'steps';
      const opened = this.openSteps;
      box.open = opened.has(at);
      box.addEventListener('toggle', () => (box.open ? opened.add(at) : opened.delete(at)));
      const summary = doc.createElement('summary');
      summary.className = 'step';
      box.append(summary);
    }
    const summary = box.children[0];
    const worked = Number(els[0].dataset.workedMs);
    // while the turn runs the latest step shows; once it ends, how long it worked
    const label = worked ? `Worked for ${workedFor(worked)}` : `${els.length} steps · ${els.at(-1).dataset.label}`;
    if (summary.textContent !== label) summary.textContent = label;
    windowed(box, els, last);
    reconcile(box, [summary, ...els]);
    this.nextGroups.set(at, box);
    return box;
  }

  /** The Chrome tab a message was sent from, by its site: the whole address on hover. */
  tabLabel(/** @type {string} */ url) {
    const el = this.doc.createElement('div');
    el.className = 'tab';
    el.title = url;
    el.textContent = siteOf(url);
    return el;
  }
}
