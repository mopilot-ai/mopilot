// The Host's line protocol over a stream to its socket: one JSON request per line, one reply by id, and the events the versioned protocol sends between them.

/**
 * @param {{ write: (text: string) => unknown, onData: (fn: (chunk: string) => void) => unknown, kill: () => void, closed: Promise<unknown> }} stream
 * @param {{ timeoutMs?: number, tap?: (dir: 'out' | 'in', msg: any) => void }} [o] `tap` hears every message sent and received (the trace of a failing step)
 */
export function lineClient(stream, { timeoutMs = 60_000, tap } = {}) {
  /** @type {Map<number, { resolve: (r: any) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }>} */
  const waiting = new Map();
  /** Messages with no id: a chat's frames and the app events. @type {any[]} */
  const events = [];
  let buffer = '';
  let id = 0;
  stream.onData((chunk) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // a line that is not JSON is the machine's own noise
        continue;
      }
      tap?.('in', message);
      const w = waiting.get(message.id);
      if (!w) {
        events.push(message);
        continue;
      }
      waiting.delete(message.id);
      clearTimeout(w.timer);
      if (message.error) w.reject(Object.assign(new Error(message.error), { code: message.code }));
      else w.resolve(message.result);
    }
  });
  void stream.closed.then(() => {
    for (const [key, w] of waiting)
      waiting.delete(key), clearTimeout(w.timer), w.reject(Object.assign(new Error('The connection closed.'), { code: 'closed' }));
  });
  return {
    events,
    /** The result of a request, or a rejection carrying the Host's `code`. @param {string} method @param {object} [params] */
    request(method, params) {
      return new Promise((resolve, reject) => {
        const n = ++id;
        const timer = setTimeout(
          () => (waiting.delete(n), reject(Object.assign(new Error(`${method} timed out.`), { code: 'timeout' }))),
          timeoutMs,
        );
        waiting.set(n, { resolve, reject, timer });
        tap?.('out', { id: n, method, params });
        stream.write(`${JSON.stringify({ id: n, method, params })}\n`);
      });
    },
    /** Wait until an event matches. @param {(e: any) => boolean} match @param {number} [ms] */
    async waitFor(match, ms = timeoutMs) {
      const end = Date.now() + ms;
      for (;;) {
        const found = events.find(match);
        if (found) return found;
        if (Date.now() > end) {
          const last = events.at(-1);
          throw new Error(
            `Timed out waiting for the Host to say so${last ? ` (it last said ${JSON.stringify(last).slice(0, 200)})` : ''}.`,
          );
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    close: () => stream.kill(),
  };
}
