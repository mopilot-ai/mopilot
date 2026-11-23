// The phantom cursor's parked state: a click's cursor stays on its point after the click until the chat's next action, the end of its turn, Stop or a take-over (Sky's does; ChatGPT 26.1103, #3810). Those end it through PhantomCursor; the backstop here only covers what sends no signal (the window closed, the app quit, a chat that never ends its turn).

/** How long a parked cursor may stay with nothing to end it. */
const PARK_MS = 120000;

class Park {
  /** @param {{ setTimeout: Function, clearTimeout: Function }} timers @param {() => void} expire */
  constructor(timers, expire) {
    this.timers = timers;
    this.expire = expire;
    /** {chatId, key} of the chat whose click is parked, or null */
    this.at = null;
    this.timer = null;
  }

  /** Parks the cursor of `chatId`'s click in app `key`, with the backstop. */
  set(chatId, key) {
    this.clear();
    this.at = { chatId, key };
    this.timer = this.timers.setTimeout(() => this.expire(), PARK_MS);
  }

  /** The cursor is no longer parked (another action took the overlay, or it hid). */
  clear() {
    this.at = null;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = { Park, PARK_MS };
