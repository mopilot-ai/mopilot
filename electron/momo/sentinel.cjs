// MoMo's sentinel (#2139): decides each MoMo tool call before it runs. A source's access level (Blocked, Read only, Read & ask to change) comes first; a change asks the user through an injected askUser(card) unless an approval for that exact action (tool, source, account, normalized arguments and destinations) is remembered (this chat, today or 30 days at most) or always denied; a call whose destination can't be told asks every time. After a chat read a private source (kept across turns and restarts, by MoPilot chat id), anything sent to a host or recipient off the allow list, and to a host the chat hasn't opened (noteOpened), asks every time, remembered approvals or not, except opening a site the user always allowed with an address that carries no data (sentinelSites.cjs); while an allowed side effect runs, and after an uncertain outcome, the same action asks again (counted and stored, sentinelMarks.cjs), except a repeatable one (a browser or computer-use act, never a change). Every ask goes through askUser, the one hook an approval card plugs into (passed at construction, electron/app/momo.cjs). Remembered answers, taint and runs are kept in injected storage; a side effect is allowed only once its run is written there, so until storage has been read, or when it can't be written, side effects are refused. Nothing is allowed for being low risk. Ideas after nanoMuse's Sentinel and Muse's approval scopes.
const crypto = require('node:crypto');
const {
  LEVELS,
  LEVEL_SET,
  SCOPES,
  KINDS,
  MAX_REMEMBER,
  MAX_TEXT,
  isRecord,
  shortText,
  destinationsOf,
  isSandbox,
  repeatable,
  normHost,
  normRecipient,
  fingerprintOf,
  grantOf,
  expiryOf,
} = require('./sentinelRules.cjs');
const { ChatMarks } = require('./sentinelMarks.cjs');
const { SiteList } = require('./sentinelSites.cjs');
const { blockOf } = require('./recipients.cjs');

/**
 * @typedef {import('./sentinelRules.cjs').Call} Call
 * @typedef {import('./sentinelRules.cjs').Grant} Grant
 * @typedef {import('./sentinelRules.cjs').Card} Card
 * @typedef {import('./sentinelRules.cjs').Answer} Answer
 * @typedef {import('./sentinelRules.cjs').Decision} Decision
 * @typedef {import('./sentinelRules.cjs').Source} Source
 * @typedef {import('./sentinelRules.cjs').Storage} Storage
 */

class Sentinel {
  /** @type {Map<string, Grant>} */
  #grants = new Map();
  /** @type {Map<string, number>} chat -> generation, raised when the chat is cleared */
  #chatGen = new Map();
  /** each chat's taint and the runs of each action, stored with the approvals */
  #marks = new ChatMarks();
  /** the sites any chat may open after a private read, with an address that carries no data (sentinelSites.cjs) */
  #sites;
  /** @type {Promise<unknown>} the end of the storage write queue */
  #tail = Promise.resolve();
  /** until storage has been read, nothing is written over it and nothing remembered counts; a change made before is written right after */
  #loaded = false;
  #dirty = false;
  /** @type {Promise<void> | null} the read in flight */
  #loadP = null;
  /** revocations made before storage was read, applied to what it holds once it is */
  #pending = { all: false, ids: new Set(), chats: new Set(), sites: new Set() };
  /** @type {unknown} */
  loadError = null;
  /** @type {unknown} */
  writeError = null;

  /**
   * @param {{ askUser: (card: Card, o: { signal: AbortSignal | null }) => Promise<Answer | null>, allowed?: () => boolean,
   *           sources?: Record<string, Source>, allowList?: { hosts?: string[], recipients?: string[] }, storage?: Storage | null,
   *           now?: () => number, newId?: () => string, sites?: InstanceType<typeof SiteList> }} o sites: the always-allowed sites, with their risk check
   *   askUser: shows the card and resolves with the answer, or null when it went away unanswered;
   *   allowed: whether MoMo is allowed for this account now (nothing is allowed without it)
   */
  constructor({
    askUser,
    allowed = () => false,
    sources = {},
    allowList = {},
    storage = null,
    now = Date.now,
    newId = () => crypto.randomUUID(),
    sites = new SiteList(),
  }) {
    this.#sites = sites;
    if (typeof askUser !== 'function') throw new Error('the sentinel needs askUser');
    this.askUser = askUser;
    this.allowed = allowed;
    this.storage = storage;
    this.now = now;
    this.newId = newId;
    /** @type {Map<string, Source>} */
    this.sources = new Map();
    for (const [id, s] of Object.entries(sources)) this.setSource(id, s);
    /** @type {{ hosts: Set<string>, recipients: Set<string> }} */
    this.allowList = { hosts: new Set(), recipients: new Set() };
    this.setAllowList(allowList);
  }

  /** The hosts and recipients a chat that read private data may still send to without asking; an entry that isn't one is left out. */
  setAllowList(/** @type {{ hosts?: string[], recipients?: string[] }} */ { hosts = [], recipients = [] }) {
    const clean = (/** @type {(string | null)[]} */ list) => new Set(/** @type {string[]} */ (list.filter(Boolean)));
    this.allowList = { hosts: clean(hosts.map(normHost)), recipients: clean(recipients.map(normRecipient)) };
  }

  /** A source's access level, whether what it holds is private, and its name for the user; an unknown source is blocked. */
  setSource(/** @type {string} */ id, /** @type {Source} */ s) {
    if (!shortText(id) || !isRecord(s) || !LEVEL_SET.has(s.level)) throw new Error('a source needs an id and a level');
    this.sources.set(id, { level: s.level, private: s.private === true, ...(shortText(s.name) ? { name: s.name } : {}) });
  }

  /**
   * Reads the remembered approvals; decide() calls it until it succeeds. Storage that can't be read (the Keychain locked, a
   * damaged file, a newer version's format) counts for nothing yet: every change asks once, and it is never written over.
   */
  load() {
    if (!this.storage || this.#loaded) return Promise.resolve();
    if (!this.#loadP)
      this.#loadP = this.#readStored().finally(() => {
        this.#loadP = null;
      });
    return this.#loadP;
  }

  async #readStored() {
    const storage = /** @type {Storage} */ (this.storage);
    let data;
    try {
      data = await storage.read();
    } catch (e) {
      this.loadError = e;
      return;
    }
    if (data != null && (!isRecord(data) || /** @type {any} */ (data).v !== 1 || !Array.isArray(/** @type {any} */ (data).grants))) {
      this.loadError = new Error('remembered approvals in an unknown format');
      return;
    }
    this.loadError = null;
    const pending = this.#pending;
    for (const raw of /** @type {any} */ (data ?? { grants: [] }).grants) {
      const g = grantOf(raw);
      // what the user revoked or cleared before storage could be read stays revoked
      const revoked = pending.all || pending.ids.has(g?.id) || (g?.scope === SCOPES.CHAT && pending.chats.has(g.chatId));
      if (g && !revoked && !this.#grants.has(g.id)) this.#grants.set(g.id, g);
    }
    if (!pending.all) this.#sites.restore(/** @type {any} */ (data)?.sites, pending.sites);
    this.#marks.restore(/** @type {any} */ (data)?.taint, /** @type {any} */ (data)?.runs, /** @type {any} */ (data)?.opened);
    for (const chatId of pending.chats) this.#marks.clear(chatId);
    this.#pending = { all: false, ids: new Set(), chats: new Set(), sites: new Set() };
    this.#ready();
    this.sweep();
  }

  /** Whether there is storage that hasn't been read yet. */
  #unread() {
    return !!this.storage && !this.#loaded;
  }

  /** The user's choice when storage stays unreadable: it is kept aside and the remembered approvals start empty. */
  async setAsideStored() {
    if (!this.storage?.setAside) return null;
    const keptAs = await this.storage.setAside();
    await this.load();
    return keptAs;
  }

  /** load() is over: from now on changes are written, the ones made while it read first. */
  #ready() {
    this.#loaded = true;
    if (this.#dirty) void this.#save();
  }

  /** Writes every grant as it is when the write runs; a failed write is kept in writeError and the next one writes everything again. */
  #save() {
    const storage = this.storage;
    if (!storage) return Promise.resolve(false);
    if (!this.#loaded) {
      this.#dirty = true;
      return Promise.resolve(false);
    }
    this.#dirty = false;
    const run = this.#tail.then(async () => {
      try {
        await storage.write({ v: 1, grants: [...this.#grants.values()], sites: this.#sites.toJSON(), ...this.#marks.toJSON() });
        this.writeError = null;
        return true;
      } catch (e) {
        this.writeError = e;
        return false;
      }
    });
    this.#tail = run;
    return run;
  }

  /** Resolves when every queued write has settled. */
  idle() {
    return this.#tail.then(() => undefined);
  }

  /** At quit: waits for the queued writes, then lets go of storage (its folder lock). */
  async close() {
    await this.idle();
    await /** @type {any} */ (this.storage)?.close?.();
  }

  #live(/** @type {Grant} */ g, now = this.now()) {
    // a clock set back before the grant was made can't stretch an approval; a refusal stays
    if (g.effect === 'allow' && now < g.createdAt) return false;
    return g.expiresAt === undefined || g.expiresAt > now;
  }

  /** Removes expired approvals; returns how many. */
  sweep() {
    const now = this.now();
    let n = 0;
    for (const [id, g] of this.#grants)
      if (!this.#live(g, now)) {
        this.#grants.delete(id);
        n++;
      }
    if (n) void this.#save();
    return n;
  }

  /** The remembered approvals and refusals still in force, newest first. */
  list() {
    const now = this.now();
    return [...this.#grants.values()]
      .filter((g) => this.#live(g, now))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((g) => ({ ...g }));
  }

  /** Forgets one remembered approval or refusal. */
  revoke(/** @type {string} */ id) {
    if (this.#unread()) this.#pending.ids.add(id);
    if (!this.#grants.delete(id) && !this.#unread()) return false;
    void this.#save();
    return true;
  }

  /** Forgets every remembered approval and refusal, and every always-allowed site; returns how many. */
  revokeAll() {
    const n = this.#grants.size + this.#sites.clear();
    this.#grants.clear();
    if (this.#unread()) this.#pending.all = true;
    if (n || this.#unread()) void this.#save();
    return n;
  }

  /** The sites any MoMo chat may open after reading private data ("Always allow <host>"), sorted. */
  listSites() {
    return this.#sites.list();
  }

  /** Forgets an always-allowed site: opening it after a private read asks again. */
  removeSite(/** @type {string} */ host) {
    const h = typeof host === 'string' ? normHost(host) : null;
    if (!h) return false;
    if (this.#unread()) this.#pending.sites.add(h);
    if (!this.#sites.remove(h) && !this.#unread()) return false;
    void this.#save();
    return true;
  }

  /** The chat was deleted or cleared: its taint, runs and this-chat approvals go with it, and a card still up for it answers nothing. */
  clearChat(/** @type {string} */ chatId) {
    this.#chatGen.set(chatId, (this.#chatGen.get(chatId) ?? 0) + 1);
    if (this.#unread()) this.#pending.chats.add(chatId);
    let n = this.#marks.clear(chatId) || this.#unread() ? 1 : 0;
    for (const [id, g] of this.#grants)
      if (g.scope === SCOPES.CHAT && g.chatId === chatId) {
        this.#grants.delete(id);
        n++;
      }
    if (n) void this.#save();
  }

  /**
   * The chat opened these hosts (a navigation that was allowed, #2283): after a private read it may still send to them,
   * the way it may to the allow list. A host that can't be read is left out. Stored with the taint.
   * @param {string} chatId @param {string[]} hosts
   */
  noteOpened(chatId, hosts) {
    let added = false;
    for (const h of hosts) {
      const host = normHost(h);
      if (host && this.#marks.markOpened(chatId, host)) added = true;
    }
    if (added) void this.#save();
  }

  /** Whether the chat opened `host` (noteOpened). */
  hasOpened(/** @type {string} */ chatId, /** @type {string} */ host) {
    const h = normHost(host);
    return !!h && this.#marks.wasOpened(chatId, h);
  }

  /** The private sources the chat has read (across all its turns). */
  taintOf(/** @type {string} */ chatId) {
    return this.#marks.taintOf(chatId);
  }

  /**
   * How an allowed side effect ended; the caller (the trust gate) reports every one. Until then it counts as running, so
   * the same action asks again (a retry while it still runs); after 'uncertain' it keeps asking, even when remembered.
   */
  noteOutcome(/** @type {string} */ chatId, /** @type {string} */ fingerprint, /** @type {string} */ result) {
    this.#marks.ended(chatId, fingerprint, result);
    void this.#save();
  }

  /** Whether a call sends somewhere a chat that read private data may not send to without asking; `sites`: counting the always-allowed ones. */
  #offList(/** @type {Call} */ call, /** @type {ReturnType<typeof destinationsOf>} */ dest, /** @type {boolean} */ sites) {
    const known = (/** @type {string} */ h) =>
      this.allowList.hosts.has(h) || this.#sites.known(call, dest, h, this.#marks.wasOpened(call.chatId, h), sites);
    return dest.unknown || dest.hosts.some((h) => !known(h)) || dest.recipients.some((r) => !this.allowList.recipients.has(r));
  }

  /** The reasons a call must ask even with a remembered approval. */
  #mustAsk(/** @type {Call} */ call, /** @type {ReturnType<typeof destinationsOf>} */ dest, /** @type {string} */ fp) {
    const reasons = [];
    const sends = dest.unknown || dest.hosts.length > 0 || dest.recipients.length > 0;
    if (this.#marks.tainted(call.chatId) && sends && this.#offList(call, dest, true)) {
      reasons.push('egress');
      // an address that may carry data, or a chat past its no-card opens, asks every time, on a listed site too, and says why
      const why = this.#sites.reason(call, dest);
      if (why) reasons.push(why);
    }
    if (!repeatable(call) && this.#marks.pending(call.chatId, fp)) reasons.push('uncertain');
    return reasons;
  }

  tainted = (/** @type {string} */ chatId) => this.#marks.tainted(chatId);
  #sideEffect(/** @type {Call} */ call, /** @type {ReturnType<typeof destinationsOf>} */ dest) {
    return call.kind === 'change' || dest.unknown || dest.hosts.length > 0 || dest.recipients.length > 0;
  }

  /**
   * An allowed change, or a call that sends data out, runs until its outcome is noted; resolves once that is in storage, or
   * false when it couldn't be written (then the run is taken back and must not happen: after a crash nothing would know it ran).
   */
  async #running(/** @type {Call} */ call, /** @type {ReturnType<typeof destinationsOf>} */ dest, /** @type {string} */ fp, fresh = false) {
    if (!this.#sideEffect(call, dest) || repeatable(call)) return true;
    const before = this.#marks.started(call.chatId, fp, fresh);
    if (!this.storage || (await this.#save())) return true;
    this.#marks.undo(call.chatId, fp, before);
    return false;
  }

  #read(/** @type {Call} */ call) {
    if (this.sources.get(call.source)?.private && this.#marks.taint(call.chatId, call.source)) void this.#save();
  }

  #level(/** @type {string} */ source) {
    return this.sources.get(source)?.level ?? LEVELS.BLOCKED;
  }

  #remembered(/** @type {Call} */ call, /** @type {string} */ fp, /** @type {'allow' | 'deny'} */ effect) {
    const now = this.now();
    for (const g of this.#grants.values())
      if (g.effect === effect && g.fingerprint === fp && this.#live(g, now) && (g.scope !== SCOPES.CHAT || g.chatId === call.chatId))
        return g;
    return null;
  }

  /**
   * Decides one MoMo tool call; the caller runs it only on `allow`.
   * @param {Call} call
   * @param {{ signal?: AbortSignal | null }} [o] the tool call's signal: aborting it withdraws the card
   * @returns {Promise<Decision>}
   */
  async decide(call, { signal = null } = {}) {
    if (!this.allowed()) return { allow: false, reason: 'not-allowed', fingerprint: null };
    await this.load();
    if (!isRecord(call) || !shortText(call.chatId) || !shortText(call.tool) || !shortText(call.source) || !KINDS.has(call.kind))
      return { allow: false, reason: 'invalid', fingerprint: null };
    let fp;
    try {
      fp = fingerprintOf(call);
    } catch {
      return { allow: false, reason: 'invalid', fingerprint: null };
    }
    const level = this.#level(call.source);
    if (level === LEVELS.BLOCKED) return { allow: false, reason: 'blocked', fingerprint: fp };
    if (call.kind === 'change' && level === LEVELS.READ) return { allow: false, reason: 'read-only', fingerprint: fp };
    if (this.#remembered(call, fp, 'deny')) return { allow: false, reason: 'deny-always', fingerprint: fp };
    const dest = destinationsOf(call.egress);
    if (isSandbox(call, dest)) return { allow: true, via: 'sandbox', fingerprint: fp };
    // a call whose destination can't be told asks every time, read or change, remembered or not; so does every change while
    // storage hasn't been read, since a deny always in it is unknown
    // a side effect needs its run on the disk before it happens: with storage that can't be read (a stored deny always or an
    // uncertain run is unknown) or written, it is refused before any card
    if (this.#sideEffect(call, dest) && this.#unread()) return { allow: false, reason: 'storage', fingerprint: fp };
    const blocked = blockOf(call, dest);
    const reasons = blocked ? [blocked] : dest.unknown ? ['unknown-destination'] : [];
    for (const r of this.#mustAsk(call, dest, fp)) if (!reasons.includes(r)) reasons.push(r);
    const storageFailed = { allow: /** @type {const} */ (false), reason: 'storage', fingerprint: fp };
    if (call.kind === 'read' && !reasons.length) {
      // allowed only by an always-allowed site, decided before this read taints the chat (else it is a plain read)
      const bySite = this.#marks.tainted(call.chatId) && this.#offList(call, dest, false) && this.#sites.spend(call, dest);
      const via = bySite ? 'site' : 'read';
      this.#read(call);
      if (!(await this.#running(call, dest, fp))) return storageFailed;
      return { allow: true, via, fingerprint: fp };
    }
    const g = reasons.length ? null : this.#remembered(call, fp, 'allow');
    if (g) {
      if (!(await this.#running(call, dest, fp))) return storageFailed;
      return { allow: true, via: 'remembered', scope: g.scope, grantId: g.id, fingerprint: fp };
    }
    return this.#ask(call, fp, dest, reasons, signal);
  }

  /** @returns {Promise<Decision>} */
  async #ask(
    /** @type {Call} */ call,
    /** @type {string} */ fp,
    /** @type {ReturnType<typeof destinationsOf>} */ dest,
    /** @type {string[]} */ reasons,
    /** @type {AbortSignal | null} */ signal,
  ) {
    // a call that must ask every time can't be remembered, and a read isn't remembered either; a navigation that asks only
    // because the chat read private data, to an address that carries no data, may make its site always allowed
    const site = reasons.length === 1 && reasons[0] === 'egress' ? this.#sites.openedBy(call, dest) : null;
    const blocked = blockOf(call, dest);
    const scopes = site
      ? [SCOPES.ONCE, SCOPES.SITE]
      : reasons.length || call.kind === 'read'
        ? [SCOPES.ONCE]
        : [SCOPES.ONCE, SCOPES.CHAT, SCOPES.TODAY, SCOPES.DAYS30];
    /** @type {Card} */
    const card = {
      chatId: call.chatId,
      tool: call.tool,
      source: call.source,
      account: call.account ?? '',
      kind: call.kind,
      summary: typeof call.summary === 'string' ? call.summary : '',
      destinations: dest,
      reasons,
      scopes: blocked ? [] : scopes,
      denyAlways: call.kind === 'change' && !blocked,
      ...(typeof call.opens === 'string' ? { opens: true } : {}),
    };
    const gen = this.#chatGen.get(call.chatId) ?? 0;
    let answer;
    try {
      answer = await this.askUser(card, { signal });
    } catch {
      answer = null;
    }
    const noAnswer = { allow: /** @type {const} */ (false), reason: 'no-answer', fingerprint: fp };
    // the chat went away while the card was up, or the call was stopped: nothing runs
    if ((this.#chatGen.get(call.chatId) ?? 0) !== gen || signal?.aborted) return noAnswer;
    if (!isRecord(answer) || typeof answer.allow !== 'boolean') return noAnswer;
    if (blocked) return { allow: false, reason: blocked, fingerprint: fp };
    // the paired device that answered, carried to the audit entry
    const by = typeof answer.by === 'string' && answer.by ? { by: answer.by } : {};
    if (!answer.allow) {
      if (answer.always === true && card.denyAlways) this.#remember(call, fp, 'deny', 'always');
      return { allow: false, reason: 'denied', fingerprint: fp, ...by };
    }
    if (!scopes.includes(answer.scope)) return noAnswer;
    // MoMo may have been turned off for this account, or the source's level changed, while the card was up
    if (!this.allowed()) return { allow: false, reason: 'not-allowed', fingerprint: fp };
    const level = this.#level(call.source);
    if (level === LEVELS.BLOCKED) return { allow: false, reason: 'blocked', fingerprint: fp };
    if (call.kind === 'change' && level === LEVELS.READ) return { allow: false, reason: 'read-only', fingerprint: fp };
    // the chat may have read private data while the card was up: then this answer covers this call only
    const tainted = this.#mustAsk(call, dest, fp).includes('egress');
    if (call.kind === 'read') this.#read(call);
    this.#sites.confirm(call, dest);
    // the user's yes, given knowing earlier runs were uncertain, clears them; this run counts from now
    if (!(await this.#running(call, dest, fp, true))) return { allow: false, reason: 'storage', fingerprint: fp };
    // the site is kept for every MoMo chat, for opening pages there with an address that carries no data; a full list allows once
    if (answer.scope === SCOPES.SITE && site && this.#sites.add(site))
      return { allow: true, via: 'asked', scope: SCOPES.SITE, persisted: await this.#save(), fingerprint: fp, ...by };
    if (answer.scope === SCOPES.ONCE || answer.scope === SCOPES.SITE || tainted)
      return { allow: true, via: 'asked', scope: SCOPES.ONCE, fingerprint: fp, ...by };
    const { grant, saved } = this.#remember(call, fp, 'allow', answer.scope);
    return { allow: true, via: 'asked', scope: answer.scope, grantId: grant.id, persisted: await saved, fingerprint: fp, ...by };
  }

  #remember(/** @type {Call} */ call, /** @type {string} */ fp, /** @type {'allow' | 'deny'} */ effect, /** @type {string} */ scope) {
    const now = this.now();
    /** @type {Grant} */
    const grant = {
      id: this.newId(),
      effect,
      fingerprint: fp,
      scope,
      ...(scope === SCOPES.CHAT ? { chatId: call.chatId } : {}),
      ...(effect === 'allow' ? { expiresAt: expiryOf(scope, now) } : {}),
      createdAt: now,
      tool: call.tool,
      source: call.source,
      account: call.account ?? '',
      summary: typeof call.summary === 'string' ? call.summary.slice(0, MAX_TEXT) : '',
    };
    // one remembered answer per exact action and scope: the new one replaces the old
    for (const [id, g] of this.#grants)
      if (g.fingerprint === fp && g.effect === effect && g.scope === scope && g.chatId === grant.chatId) this.#grants.delete(id);
    this.#grants.set(grant.id, grant);
    return { grant, saved: this.#save() };
  }
}

module.exports = { Sentinel, LEVELS, SCOPES, MAX_REMEMBER, fingerprintOf, destinationsOf, repeatable };
