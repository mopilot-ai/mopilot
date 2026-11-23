// The chat names a controller's notifications carry (#5238): the name a harness or a machine's Host told, the name the chat already has when an app restart changed nothing, and the first words of a chat nobody named; a notification waits for the saved name's read while it is under way.
const { noteIgnored } = require('../ignored.cjs');

/** @typedef {InstanceType<typeof import('./controller.cjs').ChatController>} ChatController */

class ControllerNames {
  /**
   * The name a harness (or a machine's Host) gave the chat: its notifications carry it, as a Codex chat's carry its name.
   * @this {ChatController} @param {string} chatId @param {string} name @param {boolean} [provisional] only when the chat has no name yet
   */
  rememberName(chatId, name, provisional = false) {
    const self = /** @type {any} */ (this);
    self.names ??= new Map();
    const names = self.names;
    if (!name || (provisional && names.has(chatId))) return;
    names.set(chatId, name);
    if (!provisional) (self.realNames ??= new Set()).add(chatId);
  }

  /**
   * The name a chat already has (its transcript's latest title), read once per run when the chat's first event arrives: an app restart changes no name, so no event tells it, and the first words of the latest message must not stand in for it (#5238).
   * A name an event told meanwhile is newer and stays. Notifications of a chat wait for this read while it is under way (afterName).
   * @this {ChatController} @param {string} chatId
   */
  learnSavedName(chatId) {
    const self = /** @type {any} */ (this);
    self.nameRead ??= new Set();
    if (self.nameRead.has(chatId) || typeof self.acp?.titleOf !== 'function') return;
    self.nameRead.add(chatId);
    const loads = (self.nameLoads ??= new Map());
    const load = Promise.resolve()
      .then(() => self.acp.titleOf(chatId))
      .then(
        (saved) => {
          if (saved?.name && !self.realNames?.has(chatId)) this.rememberName(chatId, saved.name);
        },
        (error) => noteIgnored("read a chat's saved name", error),
      )
      .finally(() => loads.delete(chatId));
    loads.set(chatId, load);
  }

  /** Runs `fn` now, or once the chat's saved name has been read if that read is under way. @this {ChatController} @param {string} chatId @param {() => void} fn */
  afterName(chatId, fn) {
    const load = /** @type {any} */ (this).nameLoads?.get(chatId);
    if (load) void load.then(fn);
    else fn();
  }

  /**
   * The system notification of a turn that finished, titled by the chat's name (or its agent's), once the chat's saved name has been read.
   * @this {ChatController} @param {string} chatId @param {string} text @param {string} outcome @param {string | null} summary @param {string | null} error
   */
  sayTurnEnd(chatId, text, outcome, summary, error) {
    this.afterName(chatId, () =>
      this.say('turn', chatId, {
        title: this.chatTitle(chatId) || this.labelOf(this.kindOf(chatId)),
        body: this.endBody(text, outcome, summary, error),
      }),
    );
  }
}

module.exports = { ControllerNames };
