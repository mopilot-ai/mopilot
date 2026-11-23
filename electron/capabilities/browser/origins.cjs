// Site permissions for browser control. A grant is per origin and is either 'read' (load and read
// pages) or 'write' (also click and type). Grants are remembered per site; a denial lasts only for
// the chat it was given in. Every browser channel checks here before it touches a page; the chat's
// Full access mode allows sites directly without creating permanent grants.
//
// Each browser has its own table (D4): `browser` is 'iab' (MoPilot's in-app browser, the
// browser-sites.json grants made before tables were split) or 'chrome' (the user's own Chrome, signed
// in: Your Chrome, which starts with no grants and asks again). A card names its browser, and a grant
// in one never opens a site in the other. `external` adds rules kept outside MoPilot (Codex
// Browser Use blocks): a site it names is refused like a blocked one, in every chat alike (it is never told
// the chat, so it can't depend on the chat's harness: #1319 G13).
//
// Site risk (siteRisk.cjs) comes first: a blocked URL is refused everywhere, Full access included. Full
// access doesn't cover a high-risk site: only the user's answer does (and the card says why), which may
// save it for good ("Always allow"). Its actions also ask each time (act()) until the user allows the
// site's actions for good on one of those cards (#5464); sensitive actions still ask. A URL with a user name or
// password in it asks every time. Sensitive actions (act() with `sensitive`) ask on any site; in Full access only
// payment details, password changes and OAuth consent do (siteRisk fullAccessCovers()), on every harness and
// both browsers, as this is the one place every browser action is confirmed.
//
// A card may get less than it asked for: the user picks Read only when the agent asked to read and
// write. Clicking and typing on that site are then refused for the rest of the turn with a read_only
// error telling the agent to ask the user (no second card in that turn); in a later turn the next
// write asks again, so the user can still say yes after the agent asked. A site allowed for reading
// (for good or for the chat) is never a dead end either: a write there asks, offering read and write
// (#1319 G22), as Claude Desktop and ChatGPT ask again.
//
// Auto mode, like Full access, opens an ordinary site without a card (as Claude Desktop's Auto does); its
// sensitive actions still ask (act(): only Full access covers the ordinary ones).
const { noteIgnored } = require('../../ignored.cjs');
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { writePrivate } = require('../../platform/fsutil.cjs');
const { readCheckedStore } = require('../../platform/checkedStore.cjs');
const { isJsonRecord } = require('../../../shared/jsonRecord.mjs');
const { SiteRisk, riskNote } = require('./siteRisk.cjs');
const { redactUrl } = require('./hostUtil.cjs');
const { SharedCard } = require('../sharedCard.cjs');
const { ErrandGrants } = require('./errandGrants.cjs');
const { TaskGrants } = require('./taskGrants.cjs');
const { PayFormGrants } = require('./payFormGrants.cjs');
const { confirmBrowserAction, taintCard } = require('./originAction.cjs');
const { submitTaint } = require('./submitTaint.cjs');
const { validActions, actionsOf, savedShape, allowActions } = require('./siteActions.cjs');
const { codedError, abortedBefore, unanswered, unasked } = require('./originErrors.cjs');

const {
  LEVELS,
  BROWSERS,
  originOf,
  siteOf,
  isLoopback,
  isBlank,
  riskView,
  shown,
  readOnlyNote,
  covers,
  decide,
  sitesCovered,
} = require('./originPolicy.cjs');

class OriginGrants {
  /**
   * @param {{ file?: string | null, browser?: 'iab' | 'chrome', anchor?: (ctx: { chatId: string, segmentId: string }) => string,
   *           ask: (req: { chatId: string, segmentId: string, browser: 'iab' | 'chrome', origin: string, need: 'read'|'write', allowAlways?: false | 'read', risk?: object, signal: AbortSignal }) => Promise<{ decision: 'allow'|'deny', scope?: 'once'|'chat'|'always', level?: 'read'|'write' } | null>,
   *           risk?: InstanceType<typeof import('./siteRisk.cjs').SiteRisk>,
   *           external?: ((url: string) => string | null) | null,
   *           confirmAction?: (req: { chatId: string, segmentId: string, browser: 'iab' | 'chrome', origin: string, tool: string, summary: string, actionTarget?: { url: string, page: string, label: string }, sensitive: { verb?: string, kind?: string } | null, risk?: object, signal: AbortSignal | null, task: boolean, errand?: boolean, commits?: string | null, always?: boolean }) => Promise<boolean | 'task' | 'errand' | 'always'>,
   *           attended?: (ctx: { chatId: string, segmentId: string }) => string | null,
   *           usesSaved?: (chatId: string) => boolean, turnEnd?: (chatId: string) => void,
   *           taint?: () => { check: (chatId: string, action: { kind: string, page?: string, to?: string }) => { quote: string, why: string } | null } | null }} o
   *   browser: whose table this is (the in-app browser unless named); risk: the site risk classes (offline by default);
   *   external: why a rule kept outside MoPilot blocks a URL in every chat, or null; confirmAction: the per-action card for act();
   *   ask and confirmAction pass `signal` to their card, which withdraws it when the calls waiting on it were aborted;
   *   attended: why nobody is there to answer a card now, or null (its cards then refuse as unattended);
   *   usesSaved: whether the chat gets the saved ("Always allow") sites and may add to them (every chat unless said; a remote
   *   owner of computer access (#1364) does not: its answers last as long as it does); taint: the Registry's ledger of the
   *   origins that tainted each chat's turn (G3: act() then asks before a send, delete or submit, Full access included)
   */
  constructor(o) {
    const browser = o.browser ?? 'iab';
    if (!BROWSERS.includes(browser)) throw new Error(`Unknown browser for site permissions: ${String(browser)}`);
    /** @type {'iab' | 'chrome'} */
    this.browser = browser;
    this.external = o.external || null;
    this.file = o.file || null;
    this.ask = o.ask;
    this.anchor = o.anchor || (() => 'ask');
    this.risk = o.risk || new SiteRisk();
    this.confirmAction = o.confirmAction || null;
    /** why nobody is there to answer a card now (an ACP harness working with no prompt: #1319 G11), or null */
    this.attended = o.attended || (() => null);
    this.usesSaved = o.usesSaved || (() => true);
    /** what the tables' owner lets go of when a chat's turn ends (browserSiteTables.cjs: a switch to Auto on a card) */
    this.turnEnd = o.turnEnd || (() => undefined);
    this.taint = o.taint || (() => null);
    /** origin -> 'read' | 'write' */
    this.grants = new Map();
    /** high-risk origins whose ordinary actions (clicks, typing, page JavaScript) the user allowed for good (#5464) */
    this.actions = new Set();
    this.writeError = null;
    /** chat id -> origin -> level, for "allow in this chat" */
    this.chatGrants = new Map();
    /** chat id -> origins denied in that chat */
    this.denied = new Map();
    /** chat id -> origin -> 'turn' | 'later': the user chose read only on a card that asked for read and write, this turn or before */
    this.lowered = new Map();
    /** chat id -> origins the user allowed once on another consent card this turn (consented()), each used by one check */
    this.passes = new Map();
    this.tasks = new TaskGrants(); // "Allow for this task" on a high-risk site: its ordinary actions until the turn ends
    this.payForms = new PayFormGrants(); // one yes per payment form: its fields and one submit, this turn
    this.errands = new ErrandGrants(browser); // "Allow messages for this errand": ordinary messages on a site, across turns
    /** `${chatId} ${origin}` -> the question and the storage of its answer */
    this.asking = new Map();
    /** @type {Record<string, unknown>} the saved file as read, whose other keys a write keeps */
    this.saved = {};
    this.load();
  }

  load() {
    if (!this.file) return;
    const { data, error } = readCheckedStore(
      this.file,
      'the browser site grants',
      (raw) =>
        isJsonRecord(raw) &&
        !Object.hasOwn(raw, 'version') &&
        (!Object.hasOwn(raw, 'origins') ||
          (isJsonRecord(raw.origins) &&
            Object.entries(raw.origins).every(
              ([origin, level]) => typeof level === 'string' && LEVELS.includes(level) && originOf(origin) === origin,
            ))) &&
        validActions(raw),
    );
    this.writeError = error;
    this.saved = isJsonRecord(data) ? data : {};
    this.grants.clear();
    for (const [origin, level] of Object.entries(isJsonRecord(data?.origins) ? data.origins : {}))
      if (typeof level === 'string' && LEVELS.includes(level) && originOf(origin) === origin) this.grants.set(origin, level);
    this.actions = actionsOf(data);
  }

  save() {
    if (!this.file) return;
    if (this.writeError)
      throw codedError(
        'save_failed',
        "Couldn't read the saved browser permissions, so they weren't changed. Restore the file and try again.",
      );
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writePrivate(this.file, JSON.stringify(savedShape(this.saved, this.grants, this.actions), null, 2));
    } catch {
      throw codedError('save_failed', "Couldn't save the browser permission. Please try again.");
    }
  }

  get(origin) {
    return this.grants.get(origin) || null;
  }

  /** Sets (or with null removes) the grant for an origin, as the user did in Settings or on a card; removing it also ends its actions' allowance. */
  set(origin, level) {
    if (originOf(origin) !== origin) return false;
    if (this.writeError) this.load();
    const previous = this.get(origin);
    const acted = this.actions.has(origin);
    if (level == null) {
      this.grants.delete(origin);
      this.actions.delete(origin);
    } else if (LEVELS.includes(level)) this.grants.set(origin, level);
    else return false;
    try {
      this.save();
    } catch (e) {
      if (previous === null) this.grants.delete(origin);
      else this.grants.set(origin, previous);
      if (acted) this.actions.add(origin);
      throw e;
    }
    for (const set of this.denied.values()) set.delete(origin);
    for (const m of this.lowered.values()) m.delete(origin);
    return true;
  }

  list() {
    return [...this.grants]
      .map(([origin, level]) => ({ origin, level, ...(this.actions.has(origin) ? { actions: true } : {}) }))
      .sort((a, b) => a.origin.localeCompare(b.origin));
  }

  /**
   * Whether the user allowed a high-risk site's ordinary actions for good (an "Always allow on this site" answer on an action
   * card, #5464), for this chat: a chat that doesn't use the saved sites (a remote owner, #1364) doesn't get it.
   * @param {string} chatId @param {string} origin
   */
  actionsAllowed(chatId, origin) {
    return this.actions.has(origin) && this.usesSaved(chatId);
  }

  /** Saves a site's ordinary actions as allowed for good, with its write grant (siteActions.cjs, #5464). @param {string} origin */
  allowActions(origin) {
    return allowActions(this, origin);
  }

  /**
   * The user allowed a site they had refused, from the chat's "ways forward" strip: its denial (and a
   * read-only choice) in this chat is forgotten and the site is allowed at `level` for the rest of the
   * chat. A blocked site is never allowed (false); a high-risk site gets no grant ('ask'): the next call
   * asks again and its card says why. Returns 'allowed', 'ask' or false.
   * @param {string} chatId
   * @param {string} origin
   * @param {'read' | 'write'} level
   */
  allowInChat(chatId, origin, level) {
    if (typeof chatId !== 'string' || !chatId || originOf(origin) !== origin || !LEVELS.includes(level)) return false;
    const risk = this.risk.classify(origin);
    if (risk.level === 'blocked' || this.externalBlock(origin)) return false;
    this.denied.get(chatId)?.delete(origin);
    this.lowered.get(chatId)?.delete(origin);
    if (risk.level === 'high') return 'ask';
    if (!this.chatGrants.has(chatId)) this.chatGrants.set(chatId, new Map());
    const m = this.chatGrants.get(chatId);
    if (!covers(m.get(origin), level)) m.set(origin, level);
    return 'allowed';
  }

  /** Forgets a chat's denials (the chat is over). */
  forget(chatId) {
    this.denied.delete(chatId);
    this.chatGrants.delete(chatId);
    this.lowered.delete(chatId);
    this.passes.delete(chatId);
    this.tasks.clear(chatId);
    this.payForms.clear(chatId);
    this.errands.end(chatId);
  }

  /** The chat's turn ended: a site the user lowered to read only asks again at its next write; a once consent lapses. */
  turnEnded(chatId) {
    const m = this.lowered.get(chatId);
    if (m) for (const origin of m.keys()) m.set(origin, 'later');
    this.passes.delete(chatId);
    this.tasks.end(chatId);
    this.payForms.clear(chatId);
    this.turnEnd(chatId);
  }

  /**
   * The user already allowed `origin` on another consent card in this chat (Codex's Browser plugin asks
   * for each site itself): the same answer is kept here, so the site's own card doesn't ask again.
   * 'always' saves the site for good, except a local server and a high-risk site (that card never showed its risk
   * class, which MoPilot's own card does before saving one: #5464), which keep it for the chat; 'chat' keeps it for the chat; 'once' covers the next check
   * in this turn. Per-action confirmations (act()) still ask. Returns whether anything was recorded.
   * @param {string} chatId
   * @param {string} origin
   * @param {'once' | 'chat' | 'always'} scope
   */
  consented(chatId, origin, scope) {
    if (!chatId || originOf(origin) !== origin || !['once', 'chat', 'always'].includes(scope)) return false;
    const risk = this.risk.classify(origin);
    if (risk.level === 'blocked' || this.externalBlock(origin)) return false;
    if (scope === 'once') {
      if (!this.passes.has(chatId)) this.passes.set(chatId, new Set());
      this.passes.get(chatId).add(origin);
    } else if (scope === 'always' && risk.level !== 'high' && !isLoopback(origin) && this.usesSaved(chatId)) {
      if (!covers(this.get(origin), 'write')) this.set(origin, 'write');
    } else {
      if (!this.chatGrants.has(chatId)) this.chatGrants.set(chatId, new Map());
      this.chatGrants.get(chatId).set(origin, 'write');
    }
    this.denied.get(chatId)?.delete(origin);
    this.lowered.get(chatId)?.delete(origin);
    return true;
  }

  /** A chat's explicit downgrade takes precedence; Settings edits and write approvals clear it. */
  loweredOf(chatId, origin, need) {
    if (need !== 'write') return null;
    return this.lowered.get(chatId)?.get(origin) || null;
  }

  /**
   * What a call needing `need` on `url` would get, without asking anyone: 'ok', 'ask' (nothing
   * decided yet), 'read_only' (the user allowed reading only, or the chat is read-only), 'reask' (a
   * write on a site the user lowered to read only in an earlier turn: require() asks again), 'denied'
   * (denied in this chat), 'blank' (nothing loaded) or 'other' (not an http(s) page).
   */
  peek(url, need, { chatId, segmentId }) {
    if (isBlank(url)) return 'blank';
    const risk = this.risk.classify(url);
    if (risk.level === 'blocked' || this.externalBlock(url)) return 'blocked';
    const origin = originOf(url);
    if (!origin) return 'other';
    const anchor = this.anchor({ chatId, segmentId });
    if (anchor === 'readOnly' && need === 'write') return 'read_only';
    const high = risk.level === 'high';
    if (sitesCovered(anchor) && !high && !risk.credentials) return 'ok';
    const site = this.usesSaved(chatId) ? this.get(origin) : null;
    const chat = this.chatGrants.get(chatId)?.get(origin) || null;
    const grant = covers(site, need) ? site : covers(chat, need) ? chat : site || chat;
    const deniedHere = !!this.denied.get(chatId)?.has(origin);
    const lowered = deniedHere ? null : this.loweredOf(chatId, origin, need);
    if (lowered) return lowered === 'turn' ? 'read_only' : 'reask';
    const verdict = risk.credentials ? (deniedHere ? 'denied' : 'ask') : decide(grant, need, deniedHere);
    // a site allowed for reading asks again for a write (require() puts the card up) instead of refusing it
    return verdict === 'readOnly' ? 'reask' : verdict;
  }

  /**
   * Resolves when `url` may be used for `need`; throws a coded error otherwise. Asks the user at
   * most once per chat, origin and risk requirement at a time. The answer is { level, scope }: 'once' covers this call
   * (and calls waiting on the same card), 'chat' the rest of the chat, 'always' the site for good.
   * `offer`: the level the card proposes when it differs from what the call needs (the browser_*
   * tools need read to open a page but offer read and write). `localAlways: false`: a loopback
   * origin can be allowed for good to read only; an 'always' answer to write counts for the chat. A blocked URL throws
   * 'blocked'; a high-risk site needs the user's answer, never Full access (the card shows its risk class); a URL
   * with credentials in it asks every time. A card that goes away unanswered (the turn ended) throws 'unanswered' and
   * records nothing (so does a malformed answer): only the user's Deny refuses the site for the chat.
   * @param {string} url
   * @param {'read' | 'write'} need
   * `ctx.signal`: the tool call's; once it aborts the call stops waiting, and the card goes when no other call waits on it.
   * @param {{ chatId: string, segmentId: string, signal?: AbortSignal | null }} ctx
   * @param {{ offer?: 'read' | 'write' | null, localAlways?: boolean }} [o]
   */
  async require(url, need, { chatId, segmentId, signal = null }, { offer = null, localAlways = true } = {}) {
    if (isBlank(url)) return;
    const risk = await this.risk.assess(url);
    if (risk.level === 'blocked') throw codedError('blocked', `${riskNote(risk)} ${shown(url)}`);
    const outside = this.externalBlock(url);
    if (outside) throw codedError('blocked', `${outside} ${shown(url)}`);
    const origin = originOf(url);
    if (!origin) throw codedError('bad_url', `Only http and https pages can be opened: ${String(url).slice(0, 200)}`);
    const anchor = this.anchor({ chatId, segmentId });
    if (anchor === 'readOnly' && need === 'write')
      throw codedError('read_only', 'This chat is in a read-only mode: browser control can only look.');
    const high = risk.level === 'high';
    // Full access and Auto are live, per-chat permissions, not permanent grants for other chats; they never cover a risky site.
    if (sitesCovered(anchor) && !high && !risk.credentials) return;
    const saved = this.usesSaved(chatId);
    const site = saved ? this.get(origin) : null;
    const chat = this.chatGrants.get(chatId)?.get(origin) || null;
    const grant = covers(site, need) ? site : covers(chat, need) ? chat : site || chat;
    const deniedHere = !!this.denied.get(chatId)?.has(origin);
    const lowered = deniedHere ? null : this.loweredOf(chatId, origin, need);
    // lowered this turn: refused without a second card; in an earlier turn: the card asks again
    if (lowered === 'turn') throw codedError('read_only', readOnlyNote(origin));
    const verdict = risk.credentials ? (deniedHere ? 'denied' : 'ask') : lowered ? 'ask' : decide(grant, need, deniedHere);
    if (verdict === 'ok') return;
    if (verdict === 'denied') throw codedError('denied', `The user did not allow ${origin}.`);
    // allowed once on the plugin's own card for this site: that answer covers this check, not a credentials URL
    if (!risk.credentials && this.passes.get(chatId)?.delete(origin)) return;
    this.nobodyHere({ chatId, segmentId }, `the site card for ${origin}`);
    // a high-risk site may be saved for good too (#5464): its card still shows the risk, and Full access still never covers it
    const noAlways = risk.credentials || !saved;
    // a loopback server can be allowed for good to read only; writing there is allowed for the chat at most
    const localRead = !localAlways && isLoopback(origin) && !noAlways;
    const key = JSON.stringify([chatId, origin, risk.category, risk.credentials, noAlways, localRead]);
    const card = high || risk.credentials ? { risk: riskView(risk) } : {};
    const asked = offer && LEVELS.includes(offer) ? offer : need;
    if (signal?.aborted) throw abortedBefore(origin);
    let q = this.asking.get(key);
    if (!q) {
      /** @type {InstanceType<typeof SharedCard>} */
      let shared;
      const forget = () => this.asking.get(key) === shared && this.asking.delete(key);
      /** @param {any} answer */
      const store = (answer) => {
        // every call waiting on the card was aborted: nobody answered, so nothing is stored (#1865)
        if (shared.withdrawn) return null;
        // Keep the question registered until its answer has been stored. Calls arriving as
        // the card closes must see the saved grant, rather than open a second card.
        if (answer?.decision === 'allow' && LEVELS.includes(answer.level || need)) {
          const level = answer.level || need;
          // Legacy answers inherit the original request's level, not each waiting caller's.
          answer = { ...answer, level };
          if (answer.scope === 'always' && !noAlways && !(localRead && level !== 'read')) {
            if (!covers(this.get(origin), level)) this.set(origin, level);
          } else if (answer.scope === 'chat' || answer.scope === 'always') {
            if (!this.chatGrants.has(chatId)) this.chatGrants.set(chatId, new Map());
            const m = this.chatGrants.get(chatId);
            if (!covers(m.get(origin), level)) m.set(origin, level);
          }
          // less than the card asked for: writes there are refused for the rest of this turn
          if (level === 'write') this.lowered.get(chatId)?.delete(origin);
          else if (asked === 'write') {
            if (!this.lowered.has(chatId)) this.lowered.set(chatId, new Map());
            this.lowered.get(chatId).set(origin, 'turn');
          }
        } else if (answer?.decision === 'deny') {
          if (!this.denied.has(chatId)) this.denied.set(chatId, new Set());
          this.denied.get(chatId).add(origin);
        }
        // null (the card went away unanswered: its turn ended) or a malformed answer is nobody's no: nothing is stored
        return answer;
      };
      shared = new SharedCard((cardSignal) => {
        // withdrawn: a call arriving now puts up a card of its own
        cardSignal.addEventListener('abort', forget, { once: true });
        return Promise.resolve()
          .then(() =>
            this.ask({
              chatId,
              segmentId,
              browser: this.browser,
              origin,
              need: asked,
              ...(noAlways ? { allowAlways: false } : localRead ? { allowAlways: 'read' } : {}),
              ...card,
              signal: cardSignal,
            }),
          )
          .then(store, unasked(origin))
          .finally(forget);
      });
      this.asking.set(key, (q = shared));
    }
    const answer = await q.wait(signal, () => abortedBefore(origin));
    if (answer?.decision === 'allow' && LEVELS.includes(answer.level || need)) {
      if (need === 'write' && this.anchor({ chatId, segmentId }) === 'readOnly')
        throw codedError('read_only', 'This chat is in a read-only mode: browser control can only look.');
      const level = answer.level || need;
      if (covers(level, need)) return;
      throw codedError('read_only', readOnlyNote(origin));
    }
    if (answer?.decision !== 'deny') throw unanswered(origin);
    throw codedError('denied', `The user did not allow ${origin}.`);
  }

  /** Refuses a card nobody can answer now (`attended`): the call ends as unattended instead of waiting on it. */
  nobodyHere(ctx, card) {
    const away = this.attended(ctx);
    if (away)
      throw codedError(
        'unattended',
        `${card} needs the user, and nobody is here to answer it (${away}). Don't retry; continue when the user writes.`,
      );
  }

  /** The risk class of a page (siteRisk.cjs), from the local data and what a remote check already said. */
  riskOf(url) {
    return this.risk.classify(url);
  }

  /** Why a rule kept outside MoPilot (Codex Browser Use) blocks `url`, or null; a rule source that throws blocks nothing. */
  externalBlock(url) {
    if (!this.external) return null;
    try {
      const why = this.external(String(url));
      return typeof why === 'string' && why ? why : null;
    } catch (error) {
      noteIgnored('read the Codex Browser Use site rules', error);
      return null;
    }
  }

  /** What a refusal of a page peek() calls 'blocked' says: its risk class, or the outside rule that blocks it, and the address. */
  blockNote(url) {
    const risk = this.risk.classify(url);
    const why = risk.level === 'blocked' ? riskNote(risk) : (this.externalBlock(url) ?? riskNote(risk));
    // the address without credentials or token-like query values (as the browser_* tools show one)
    return `${why} ${redactUrl(String(url)).slice(0, 200)}`;
  }

  /**
   * Resolves when an action (a click, typing, JavaScript...) may run on `url`: on a high-risk site the user
   * confirms it each time, Full access included, unless they allowed the site's actions for good; a sensitive action on any other site too, except one Full
   * access covers (fullAccessCovers(): a delete, purchase, transfer, sent message or upload). Resolves true
   * when the user was asked (the page may have changed meanwhile), false when no card was needed.
   * Throws 'blocked' for a blocked URL, 'denied' when the user says no, 'disabled' with no way to ask.
   * `sensitive`: what siteRisk.sensitiveAction() named, or null.
   * @param {string} url
   * @param {{ chatId: string, segmentId: string, signal?: AbortSignal | null }} ctx `signal`: the tool call's, which withdraws the card
   * @param {{ tool?: string, summary?: string, sensitive?: { verb?: string, kind?: string } | null, ordinary?: boolean, script?: boolean, taint?: import('./originAction.cjs').TaintAction | null }} [what] `ordinary`: the caller read the action and found it ordinary (taskGrants.cjs taskCovers); `script`: page JavaScript; `taint`: what the action is to a tainted turn (a submit, page JavaScript, a navigation)
   */
  async act(url, ctx, what) {
    return confirmBrowserAction(this, url, ctx, what);
  }

  /**
   * Whether a tainted turn asks before this action (G3: originAction.cjs taintCard), for a caller that asks act() only
   * when something calls for a card (the Codex Browser plugin's backend).
   * @param {{ chatId: string }} ctx @param {string} url @param {import('./originAction.cjs').TaintAction | null} taint
   */
  tainted(ctx, url, taint) {
    return !!taintCard(this, ctx.chatId, url, null, taint);
  }

  /** What submitting a form this action is (./submitTaint.cjs), for a caller that has no other way to it. */
  submitTaint(intent, action) {
    return submitTaint(intent, action);
  }
}

module.exports = { OriginGrants, originOf, siteOf, isBlank, isLoopback, covers, decide, riskView, readOnlyNote, LEVELS, BROWSERS };
