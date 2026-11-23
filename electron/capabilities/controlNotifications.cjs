// System notifications for computer control: when a chat starts working in an app ("Claude is using your
// computer") and when it is done ("Claude is done using your computer"), as Claude Desktop words them. They go through the app's notifier
// (electron/platform/notify.cjs) as the "computer" kind, so the Notifications setting and its
// per-kind switch apply; macOS holds them back under Do Not Disturb or a Focus; clicking one opens
// the chat. Background control (one app, stopped from the chat) gets both on every harness. Display-scope
// control (the whole screen, where Esc stops it) gets only the done one: a banner while the agent clicks
// sits over the screen it clicks, and the hit test refuses a click that would land on Notification Center
// (the pill and the glow already say who is in control).

const { identityKey } = require('../../shared/identityKey.mjs');
const { usingText, doneText } = require('./computerPresentation.cjs');

class ControlNotifications {
  /**
   * @param {object} o
   * @param {(kind: string, chatId: string, opts: object) => any} o.notify the app's notifier (Notifier.notify)
   * @param {(chatId: string) => string | null} o.agentName "Claude", "Codex", or the ACP agent's name (null: unknown)
   * @param {(chatId: string) => string | null} [o.chatName]
   * @param {(chatId: string) => boolean} [o.viewing] whether a window shows the chat (with focus, nothing is shown)
   * @param {(app: string) => string | Promise<string>} [o.appName] what a person calls the app (a bundle id resolves later)
   */
  constructor(o) {
    this.notifyFn = o.notify;
    this.agentName = o.agentName;
    this.chatName = o.chatName || (() => null);
    this.viewing = o.viewing || (() => false);
    this.appName = o.appName || ((app) => app);
    /** Structured chat/app tuple -> the name it was noted by, for each app a chat is using */
    this.active = new Map();
  }

  /**
   * The chat started controlling `app`: once until it is done there. Returns what the notifier showed (a
   * promise of it when the app's name resolves later; nothing then if the chat was done meanwhile).
   */
  started(chatId, app, opts = {}) {
    const k = identityKey(chatId, app);
    if (!app || this.active.has(k)) return null;
    const named = this.appName(app);
    this.active.set(k, named);
    if (typeof named === 'string') return this.#using(chatId, named, opts);
    return named.then((name) => {
      if (this.active.get(k) !== named) return null;
      this.active.set(k, name);
      return this.#using(chatId, name, opts);
    });
  }

  #using(chatId, app, { background = false }) {
    // the whole screen: no banner over what the agent clicks (it would take the click), only "Done using" after
    if (!background) return null;
    const chat = this.chatName(chatId);
    return this.#send(chatId, 'using', usingText(this.agentName(chatId)), chat || '', chat);
  }

  /** The chat is done in `app` (only after it started there). */
  finished(chatId, app) {
    const k = identityKey(chatId, app);
    const name = this.active.get(k);
    if (!this.active.delete(k) || typeof name !== 'string') return null;
    const chat = this.chatName(chatId);
    return this.#send(chatId, 'done', doneText(this.agentName(chatId)), chat || '', chat);
  }

  #send(chatId, group, title, body, chat) {
    return this.notifyFn('computer', chatId, { title, body, chatTitle: chat ?? title, group, viewing: this.viewing(chatId) }) ?? null;
  }
}

module.exports = { ControlNotifications };
