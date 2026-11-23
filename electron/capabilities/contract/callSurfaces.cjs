// Which surface a chat's running tool calls show (the in-app browser's page or the screen), the surface its last call used (and the app it named), and who hears that the running calls changed; the remote mirrors read it to capture only while a tool runs, a phone reads where the chat works.
class CallSurfaces {
  /**
   * @param {(chatId: string) => Iterable<AbortController>} runningOf the calls running for a chat
   * @param {(tool: any) => string | null | undefined} needsOf the surface a tool needs from its Host ('iab', 'cu', ...)
   * @param {(error: unknown) => void} onError where a listener's error is recorded
   */
  constructor(runningOf, needsOf, onError) {
    this.onError = onError;
    this.runningOf = runningOf;
    this.needsOf = needsOf;
    /** @type {WeakMap<AbortController, any>} each running call's tool */
    this.toolOf = new WeakMap();
    /** @type {Set<(chatId: string) => void>} */
    this.listeners = new Set();
    /** @type {Map<string, { needs: string, app: string | null }>} each chat's last call that used a surface, and the app a desktop call named */
    this.lastOf = new Map();
  }

  /** A call began for the chat. */
  began(/** @type {string} */ chatId, /** @type {AbortController} */ call, /** @type {any} */ tool, /** @type {any} */ args = null) {
    this.toolOf.set(call, tool);
    const needs = this.needsOf(tool);
    if (needs === 'iab' || needs === 'bu' || needs === 'cu') {
      // a desktop call that names no app (a screenshot of the screen) keeps the app the chat last worked in
      const named = typeof args?.app === 'string' && args.app.trim() ? args.app.trim() : null;
      const before = this.lastOf.get(chatId);
      this.lastOf.set(chatId, { needs, app: needs === 'cu' ? (named ?? (before?.needs === 'cu' ? before.app : null)) : null });
    }
    this.changed(chatId);
  }

  /** The chat was archived or deleted: its last surface goes with it. @param {string} chatId */
  forget(chatId) {
    this.lastOf.delete(chatId);
  }

  /** The surface the chat's last call used ('iab', 'bu' or 'cu') and the app a desktop call named; null before any. */
  last(/** @type {string} */ chatId) {
    return this.lastOf.get(chatId) ?? null;
  }

  /** The chat's running calls changed; one listener's error does not reach the others or the call. */
  changed(/** @type {string} */ chatId) {
    for (const fn of [...this.listeners]) {
      try {
        fn(chatId);
      } catch (error) {
        this.onError(error);
      }
    }
  }

  /** Hears every change in which calls run for a chat; returns the way to stop. */
  onChange(/** @type {(chatId: string) => void} */ fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** What a call running for the chat now shows: 'browser' (the in-app browser's page), 'screen', or null. */
  of(/** @type {string} */ chatId) {
    for (const call of this.runningOf(chatId)) {
      const needs = this.needsOf(this.toolOf.get(call));
      if (needs === 'iab') return 'browser';
      if (needs === 'cu') return 'screen';
    }
    return null;
  }
}

module.exports = { CallSurfaces };
