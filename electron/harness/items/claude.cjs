// A Claude Code chat's events as thread items, translated once in main (docs/architecture/rust-core.md §6 step 4:
// translation in one place, not in each window): one ClaudeTranslator (the core's, core/crates/translate) per native session
// for every window, fed every event of it, the window-targeted ones (turnStarting, steered, turnFailed) included, so a turn
// has one id everywhere; its Codex-shaped notifications go to the windows on claude:items.
const { ClaudeTranslator } = require('./claudeTranslator.cjs');
const { userInput } = require('../../../shared/userInput.mjs');

/** What a turn that ends with its CLI gone says, as the ChatController puts it on the crashed chat (A23). */
const QUIT = 'Claude Code quit while working. Pending approvals were cancelled · Your queued messages are kept';

/** How many sessions keep a translator here: a chat dropped without a word from its CLI says nothing here, so past this the oldest idle one goes. */
const MAX_TRANSLATORS = 256;

/** @typedef {(chatId: string, key: string, method: string, params: Record<string, unknown>) => void} ItemEmit */

class ClaudeItems {
  /**
   * @param {{ chatOf: (key: string) => string, cwdOf: (key: string) => string | null | undefined, emit: ItemEmit }} o
   */
  constructor({ chatOf, cwdOf, emit }) {
    this.o = { chatOf, cwdOf, emit };
    /** @type {Map<string, { chatId: string, translator: InstanceType<typeof ClaudeTranslator> }>} */
    this.entries = new Map();
    /** The folder each running CLI was started in (processStarted): a resumed chat's, which no window registered here. */
    this.cwds = new Map();
  }

  /**
   * The translation for main's late-bound services: the controller maps sessions to chats (each to itself before it
   * exists), and main's Claude adapter knows each live session's folder.
   * @param {{ controller?: { chatOf(key: string): string | undefined } | null,
   *   claudeTurns?: { sessions?: Map<string, { cwd?: string | null }> } | null }} live
   * @param {ItemEmit} emit
   */
  static of(live, emit) {
    return new ClaudeItems({
      chatOf: (key) => live.controller?.chatOf(key) ?? key,
      cwdOf: (key) => live.claudeTurns?.sessions?.get(key)?.cwd,
      emit,
    });
  }

  /** The session's translator while it still reports under the chat that owns it. */
  get(key) {
    const entry = this.entries.get(key);
    if (entry && entry.chatId !== this.o.chatOf(key)) {
      this.drop(key);
      return undefined;
    }
    return entry?.translator;
  }

  /** The session is gone, or has another owner: its translator goes with it. */
  drop(key) {
    this.entries.get(key)?.translator.close();
    this.entries.delete(key);
  }

  /** Let the oldest session with no turn running go, other than `key`, which has just come. An event would start it afresh. */
  dropIdle(key) {
    for (const [other, entry] of this.entries) {
      if (other !== key && !entry.translator.turnId) return this.drop(other);
    }
  }

  ensure(key) {
    const existing = this.get(key);
    if (existing) return existing;
    const chatId = this.o.chatOf(key);
    const cwd = this.o.cwdOf(key) || this.cwds.get(key) || '';
    const translator = new ClaudeTranslator(chatId, cwd, (method, params) => this.o.emit(chatId, key, method, params));
    this.entries.set(key, { chatId, translator });
    if (this.entries.size > MAX_TRANSLATORS) this.dropIdle(key);
    return translator;
  }

  /** The turn the session is running here, as its items name it; null when none is (claude:turns gives it this id). */
  liveTurn(key) {
    return this.get(key)?.turnId ?? null;
  }

  /** One event of a Claude Code session (from the harness or from main's adapter), translated into the chat's items. */
  onEvent(e) {
    const key = e?.key;
    if (typeof key !== 'string') return;
    switch (e.kind) {
      case 'message':
        // the account's limits, which the window shows; not a part of the turn
        if (e.msg?.type !== 'rate_limit_event') this.ensure(key).onMessage(e.msg);
        return;
      case 'turnStarting':
        this.ensure(key).beginTurn(e.turnId, { id: `u-${e.clientId}`, clientId: e.clientId, content: userInput(e.text, e.attachments) });
        return;
      case 'turnFailed':
        this.ensure(key).endTurn('failed', e.error);
        return;
      case 'steered': {
        const tr = this.ensure(key);
        const user = { id: e.clientId, clientId: e.clientId, content: userInput(e.text, e.attachments) };
        // no turn open (main came to this session mid-turn): the message opens the one it is shown in
        if (!tr.turnId) return tr.beginTurn(`ct-${e.clientId}`, user);
        tr.addSteer();
        // the chat ensure() made the translator for
        const { chatId } = /** @type {{ chatId: string }} */ (this.entries.get(key));
        this.o.emit(chatId, key, 'item/completed', { threadId: chatId, turnId: tr.turnId, item: { type: 'userMessage', ...user } });
        return;
      }
      case 'steerFailed':
        this.get(key)?.dropSteer();
        return;
      case 'interrupting':
        this.get(key)?.markInterrupted();
        return;
      case 'processStarted': {
        if (typeof e.cwd !== 'string' || !e.cwd) return;
        this.cwds.set(key, e.cwd);
        // a turn that began before its CLI started (a resumed chat) names that CLI's folder from here on
        const tr = this.get(key);
        if (tr && !tr.cwd) tr.cwd = e.cwd;
        return;
      }
      case 'closed':
      case 'error': {
        const tr = this.get(key);
        // the CLI quit mid-turn: the turn ends with what happened
        if (tr?.turnId) tr.endTurn(tr.interrupted ? 'interrupted' : 'failed', e.kind === 'error' ? e.error : QUIT);
        // its next CLI resumes from the transcript, as a reloaded window's fresh translator would: nothing is kept for it
        if (e.kind === 'closed') {
          this.drop(key);
          this.cwds.delete(key);
        }
        return;
      }
    }
  }
}

/**
 * How Claude Code events reach the windows (electron/app/windows.cjs): `send` passes each on and translates it here right
 * after, whichever window it is for, its items going to every window: the window that sent a message shows it
 * (turnStarting) before main's turn/started names its turn. A delta the stream batcher sends again for the windows that
 * have its chat in the background (`scope.background`, electron/harness/coreBatcher.cjs) is the same delta, translated
 * once already. `pages` is what main's claude:turns lays on a transcript's page.
 * @param {Parameters<typeof ClaudeItems.of>[0]} live
 * @param {(channel: string, event: any, target?: any, scope?: any) => boolean} sendToWindows
 */
function claudeSender(live, sendToWindows) {
  const items = ClaudeItems.of(live, (chatId, key, method, params) => sendToWindows('claude:items', { chatId, key, method, params }));
  return {
    send(event, target, scope) {
      const sent = sendToWindows('claude:event', event, target, scope);
      if (!scope?.background) items.onEvent(event);
      return sent;
    },
    /** What a transcript page takes from this app: the turn a session runs here, and what each of its turns changed. */
    pages: {
      liveTurn: (/** @type {string} */ key) => items.liveTurn(key),
      diffs: (/** @type {string} */ key, /** @type {string[]} */ ids) =>
        /** @type {any} */ (live.controller)?.turnSnapshots?.savedDiffs(key, ids) ?? {},
    },
  };
}

module.exports = { ClaudeItems, claudeSender, QUIT };
