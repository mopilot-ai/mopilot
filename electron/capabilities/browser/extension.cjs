// "Your Chrome": MoPilot is the MCP client of a pinned @playwright/mcp running in --extension
// mode, which reaches the user's real Chrome through the Playwright Extension. Each chat gets its own
// instance (an Electron utilityProcess running ./playwrightHost.cjs), so each chat gets its own tab
// group. Agents see a fixed set of its tools as sage_browser_*, behind Your Chrome's own site permissions
// (a table apart from the in-app browser's, D4) and the in-app browser's checks on writes: password fields
// refuse typing, and sensitive clicks, submit keys, form fills and dialog accepts ask (chromeIntent.cjs).
const { noteIgnored } = require('../../ignored.cjs');
const { contentBlocks } = require('../../../shared/contentBlocks.mjs');
const { extensionVersionCheck } = require('./chromeMigration.cjs');
const { mayAct } = require('../contract/actionGuard.cjs');
const { AsyncResource } = require('node:async_hooks');
const { PlaywrightInstance, spawnSpec, HOST } = require('./extensionProcess.cjs');
const { NEEDS, sageName, pageUrl, modalStates } = require('./extensionResults.cjs');
const { chromeTools } = require('./extensionTools.cjs');

const EXTENSION_URL = 'https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm';
const IDLE_MS = 10 * 60_000;
/** How long a call on an instance Chrome has not approved yet waits before the chat is told to approve it there. */
const APPROVAL_MS = 2_000;

/**
 * The instances, one per chat: started on a chat's first call and started again on the next call after a crash.
 * An instance ends after IDLE_MS without a call, but never while one of the chat's calls (with the cards it
 * waits on) is in flight or the chat's turn runs: ending it closes the chat's tab group and what the task left
 * half done there. Only a call that never answered, a cancelled handoff and quitting end one at once.
 */
class ChromeChannel {
  /**
   * @param {{ fork: Function, spec: () => ReturnType<typeof spawnSpec>, clientName?: string, idleMs?: number, callMs?: number,
   *   approvalMs?: number, extensionVersion?: () => string | null, pinnedExtension?: string, busy?: (chatId: string) => boolean,
   *   onApproval?: (chatId: string, waiting: boolean) => void }} o  extensionVersion: the installed extension's version (read from
   *   Chrome's profile; the relay doesn't report it), checked against pinnedExtension by the connection test. busy: whether the
   *   chat's turn runs. onApproval: the chat's call waits for the user to approve the connection in Chrome, or no longer does
   */
  constructor(o) {
    this.o = o;
    this.idleMs = o.idleMs ?? IDLE_MS;
    this.approvalMs = o.approvalMs ?? APPROVAL_MS;
    this.busy = o.busy ?? (() => false);
    /**
     * chat id -> { inst: Promise<PlaywrightInstance>, ready: PlaywrightInstance | null, timer, idleMs: how long it waits
     * for the next call, release: it ends once nothing holds it, restart: that is for a new profile or token }
     */
    this.chats = new Map();
    /** chat id -> its calls in flight (hold()), each as whether it may still act (a stopped call no longer holds anything) */
    this.inflight = new Map();
    /** chats told to approve the connection in Chrome */
    this.approving = new Set();
    this.schemas = null;
  }

  #spawn(clientName) {
    const inst = new PlaywrightInstance({ fork: this.o.fork, spec: this.o.spec(), clientName, callMs: this.o.callMs });
    return inst.start().then(
      () => inst,
      (e) => {
        void inst.stop();
        throw e;
      },
    );
  }

  /**
   * The chat's instance, started if it has none. `idleMs`: how long it may wait for the next call this time
   * (a handoff waits for the user to sign in).
   */
  instance(chatId, { idleMs = this.idleMs } = {}) {
    let e = this.chats.get(chatId);
    if (!e) {
      e = { inst: this.#spawn(this.o.clientName || 'MoPilot'), ready: null, timer: null, idleMs, release: false, restart: false };
      this.chats.set(chatId, e);
      const entry = e;
      e.inst.then(
        (inst) => {
          entry.ready = inst;
          inst.once('exit', () => this.chats.get(chatId) === entry && this.#drop(chatId));
          // a call that never answered may still run when Chrome gets to it: the instance goes (the next call reconnects)
          inst.on('timeout', () => this.chats.get(chatId) === entry && this.stop(chatId));
        },
        () => this.chats.get(chatId) === entry && this.#drop(chatId),
      );
    }
    // a handoff's longer wait lasts until the agent's next call, whatever ends meanwhile
    e.idleMs = idleMs;
    this.#arm(chatId, e);
    return e.inst;
  }

  /** Whether the chat has an instance, started or starting. */
  has(chatId) {
    return this.chats.has(chatId);
  }

  #arm(chatId, e) {
    clearTimeout(e.timer);
    e.timer = setTimeout(() => this.#settle(chatId), e.idleMs);
    e.timer.unref?.();
  }

  /** Whether a call of the chat that may still act is in flight. */
  #calling(chatId) {
    return [...(this.inflight.get(chatId) ?? [])].some((live) => live());
  }

  /** Whether something of the chat still needs its instance: a call in flight, or its turn. */
  #held(chatId) {
    return this.#calling(chatId) || this.busy(chatId);
  }

  /** The idle timer fired, a call ended or the turn did: the instance ends if it is let go and nothing holds it. */
  #settle(chatId, idle = true) {
    const e = this.chats.get(chatId);
    if (!e) return;
    if (this.#held(chatId)) {
      // a call in flight re-checks when it ends; a running turn when the timer fires again or the turn ends
      if (!this.#calling(chatId)) this.#arm(chatId, e);
    } else if (idle || e.release) this.stop(chatId);
    else this.#arm(chatId, e);
  }

  /**
   * Runs one call of the chat's (and the cards it waits on): the instance is not let go meanwhile, and a call
   * still waiting after a moment on a connection Chrome has not approved tells the chat to approve it there.
   * @template T
   * @param {string} chatId
   * @param {() => Promise<T>} fn
   * @param {AbortSignal | null} [signal] the call's own stop
   * @returns {Promise<T>}
   */
  async hold(chatId, fn, signal = null) {
    // whether this call may still act, read in its own context (../contract/actionGuard.cjs): a call stopped by the user, its
    // harness or the turn's end keeps nothing alive, even while its handler still waits on a card
    const live = AsyncResource.bind(mayAct);
    let calls = this.inflight.get(chatId);
    if (!calls) this.inflight.set(chatId, (calls = new Set()));
    calls.add(live);
    // a stopped call lets go at once: an instance released meanwhile ends without waiting for the handler
    const onStop = () => this.#settle(chatId, false);
    signal?.addEventListener('abort', onStop, { once: true });
    // looked at again while the call runs: a CLI that is still starting has not asked Chrome yet
    const ask = setInterval(() => {
      if (live() && this.chats.get(chatId)?.ready?.awaitingApproval && !this.approving.has(chatId)) {
        this.approving.add(chatId);
        this.o.onApproval?.(chatId, true);
      }
    }, this.approvalMs);
    ask.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(ask);
      signal?.removeEventListener('abort', onStop);
      calls.delete(live);
      if (!calls.size && this.inflight.get(chatId) === calls) this.inflight.delete(chatId);
      const calling = this.#calling(chatId);
      if (!calling || !this.chats.get(chatId)?.ready?.awaitingApproval) this.#approved(chatId);
      if (!calling) this.#settle(chatId, false);
    }
  }

  /** The chat no longer waits for the user to approve the connection in Chrome. */
  #approved(chatId) {
    if (this.approving.delete(chatId)) this.o.onApproval?.(chatId, false);
  }

  /**
   * The chat's lease in Your Chrome (TargetLeases): its instance's tab group, while it has one. The group is the
   * instance's, so it closes with it (idle, released or quitting), not per tab at the turn end.
   * @returns {import('../targetLeases.cjs').Lease[]}
   */
  leases(chatId) {
    return this.chats.has(chatId) ? [{ surface: 'chrome', id: 'group', origin: 'agent', mark: null, held: this.#calling(chatId) }] : [];
  }

  /** The chat's turn ended: its instance waits IDLE_MS for the next call, or ends now when it was let go meanwhile. */
  turnEnded(chatId) {
    this.#settle(chatId, false);
  }

  // only called for a chat that has an entry (stop() checks, the exit handlers compare it)
  #drop(chatId) {
    clearTimeout(this.chats.get(chatId).timer);
    this.chats.delete(chatId);
    this.#approved(chatId);
  }

  /**
   * Ends the chat's instance now, whatever it is doing: only for a call that never answered, a cancelled handoff
   * and quitting. Everything else lets go with release().
   * @returns {Promise<void>} once the CLI exited
   */
  stop(chatId) {
    const e = this.chats.get(chatId);
    if (!e) return Promise.resolve();
    this.#drop(chatId);
    return e.inst.then(
      (i) => i.stop(),
      () => {
        /* an instance that failed to start has nothing to stop */
      },
    );
  }

  /**
   * The chat is done with its instance (archived, cleared): it ends now, or once the calls in flight and the
   * turn running end. @returns {boolean} whether it ended now
   */
  release(chatId) {
    const e = this.chats.get(chatId);
    if (!e) return false;
    e.release = true;
    if (this.#held(chatId)) return false;
    void this.stop(chatId);
    return true;
  }

  /**
   * A new Chrome profile or token: every instance is let go, so each chat's next one uses it. A chat working in
   * its Chrome keeps its instance until its calls and turn end. @returns {string[]} the chats that keep theirs for now
   */
  restartAll() {
    for (const e of this.chats.values()) e.restart = true;
    return [...this.chats.keys()].filter((id) => !this.release(id));
  }

  /** The chats that still use the previous profile or token until their calls and turn end (restartAll()). */
  releasing() {
    return [...this.chats].filter(([, e]) => e.restart).map(([id]) => id);
  }

  /** Quitting: every instance ends now. @returns {Promise<void>} once each CLI exited (it closes its tab group first) */
  async stopAll() {
    await Promise.all([...this.chats.keys()].map((id) => this.stop(id)));
  }

  /** The Playwright tools agents may use, as listed by a short-lived instance (no browser needed). */
  async tools() {
    if (this.schemas) return this.schemas;
    const inst = await this.#spawn('MoPilot');
    try {
      this.schemas = (await inst.listTools()).filter((t) => NEEDS[t.name]);
      return this.schemas;
    } finally {
      void inst.stop();
    }
  }

  /** The connection test: a short-lived instance lists its tab group's tabs, which connects to Chrome. */
  async test() {
    const out = await this.#connect();
    if (!this.o.extensionVersion || !this.o.pinnedExtension) return out;
    /** @type {string | null} */
    let installed = null;
    try {
      installed = this.o.extensionVersion();
    } catch (error) {
      // unknown installed version: the check below reports it as missing
      noteIgnored('read the installed Playwright Extension version', error);
    }
    const extension = extensionVersionCheck(installed, this.o.pinnedExtension);
    return { ...out, message: extension.message && out.ok ? `${out.message} ${extension.message}` : out.message, extension };
  }

  async #connect() {
    let inst;
    let out;
    try {
      inst = await this.#spawn('MoPilot connection test');
      const r = await inst.call('browser_tabs', { action: 'list' });
      const text = contentBlocks(r.content)
        .map((c) => c.text || '')
        .join('\n');
      out = r.isError
        ? {
            ok: false,
            message: text
              .replace(/^### Error\s*/, '')
              .replace(/^Error: /, '')
              .trim(),
          }
        : { ok: true, message: 'Connected to Chrome.' };
    } catch (e) {
      out = { ok: false, message: String((e && e.message) || e) };
    }
    void inst?.stop();
    return out;
  }
}

module.exports = {
  ChromeChannel,
  PlaywrightInstance,
  chromeTools,
  spawnSpec,
  pageUrl,
  modalStates,
  sageName,
  NEEDS,
  EXTENSION_URL,
  HOST,
};
