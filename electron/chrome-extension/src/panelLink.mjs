// The side panel's requests to MoPilot on the extension's paired connection (main's end: electron/capabilities/browser/chromePanel.cjs): ids, answers, time limits, and MoPilot's updates for the panel.
//
//   extension -> app  { type: 'panel', id, method, params }
//   app -> extension  { type: 'panel', id, result } | { type: 'panel', id, error } | { type: 'panel', event }
// A request is never sent on a connection that isn't up, and every request still waiting ends when the connection
// goes (drop), so the panel always hears back.

/** The code of an error that is the transport's (not connected, no answer, went away), not a refusal: the panel may offer Retry for one. */
export const CONNECTION_LOST = 'panel_connection';
const lost = (message) => Object.assign(new Error(message), { code: CONNECTION_LOST });

export const REQUEST_MS = 15_000;
/** A new chat may have to start its harness before it takes the first message. */
export const START_MS = 60_000;
/** A clip may be tried on several dictation services in turn (electron/app/chromePanelDictate.cjs CHAIN_MS is under this). */
export const TRANSCRIBE_MS = 150_000;

export class PanelLink {
  /**
   * @param {{ send: (m: object) => void, connected: () => boolean, event?: (e: object) => void,
   *           timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout } }} o
   *   send: on the paired connection; event: one of MoPilot's updates (a chat's turn changed), for the panel's pages
   */
  constructor(o) {
    this.o = o;
    this.timers = o.timers ?? globalThis;
    this.next = 1;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: any, method: string }>} */
    this.pending = new Map();
  }

  /**
   * One request; resolves with MoPilot's result, rejects with a line the panel can show.
   * @param {string} method @param {object} [params]
   * @returns {Promise<any>}
   */
  request(method, params = {}) {
    if (!this.o.connected()) return Promise.reject(lost("MoPilot isn't connected."));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(
        () => {
          this.pending.delete(id);
          reject(this.unconfirmed(method, lost("MoPilot didn't answer. Try again.")));
        },
        method === 'start' ? START_MS : method === 'transcribe' ? TRANSCRIBE_MS : REQUEST_MS,
      );
      this.pending.set(id, { resolve, reject, timer, method });
      this.o.send({ type: 'panel', id, method, params });
    });
  }

  /** After handing input to main, a transport timeout cannot prove that main rejected it. */
  unconfirmed(method, /** @type {Error} */ fallback) {
    return ['start', 'send'].includes(method)
      ? Object.assign(new Error('Delivery is unconfirmed. Check the chat before sending again.'), { code: 'delivery_unconfirmed' })
      : fallback;
  }

  /** A panel message from MoPilot: an answer to a request still waiting, or an update. */
  receive(/** @type {any} */ m) {
    if (m?.event && typeof m.event === 'object') {
      this.o.event?.(m.event);
      return;
    }
    const p = this.pending.get(m?.id);
    if (!p) return;
    this.pending.delete(m.id);
    this.timers.clearTimeout(p.timer);
    if (typeof m.error === 'string') p.reject(Object.assign(new Error(m.error), typeof m.code === 'string' ? { code: m.code } : {}));
    else p.resolve(m.result ?? {});
  }

  /** The connection went away: every request still waiting ends now. */
  drop() {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) {
      this.timers.clearTimeout(p.timer);
      p.reject(this.unconfirmed(p.method, lost('MoPilot went away. Try again.')));
    }
  }
}
