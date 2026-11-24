// One authenticated connection to a paired Host for a run of requests, with the events the Host sends while a request runs (clone progress); the connection ends when the caller closes it or the Host drops it.
const net = require('node:net');
const { clock } = require('../platform/ports/clock.cjs');
const { authenticate } = require('./pairingClient.cjs');
const { userError } = require('../../shared/userError.mjs');
const frames = require('../../shared/host/frames.mjs');

/** A refusal from the Host or the connection, with the Host's `code` when it sent one. @param {string} message @param {string} [code] */
const refusal = (message, code, extra = {}) => Object.assign(new Error(message), code ? { code } : {}, extra);

/**
 * Connects to `socketPath`, proves this install holds its key, and returns `call` and `close`. Rejects when the Host does not answer in `helloMs` or refuses the proof.
 * @param {object} o
 * @param {string} o.socketPath
 * @param {import('./pairingClient.cjs').Identity} o.identity
 * @param {(event: Record<string, any>) => void} [o.onEvent] told each `event` message the Host sends, and `{ event: 'connection.closed', reason }` once when the connection ends (a request still waiting fails then too)
 * @param {(socketPath: string) => import('node:net').Socket} [o.connect]
 * @param {number} [o.helloMs]
 * @param {number} [o.callMs] how long a `call` may take unless it says otherwise; 0 waits as long as the connection lasts
 * @param {(error: unknown) => void} [o.report] told when the listener of an event throws
 */
function openSession({
  socketPath,
  identity,
  onEvent = () => undefined,
  connect = (p) => net.connect(p),
  helloMs = 15_000,
  callMs = 15_000,
  report = () => undefined,
}) {
  const socket = connect(socketPath);
  const decoder = frames.createDecoder();
  let closed = false;
  let nextId = 1;
  /** @type {Map<number, { settle: (v: { value?: any, error?: Error }) => void, timer: any }>} */
  const pending = new Map();

  /** Every request still waiting fails with `why`, and the connection is gone. @param {string} why */
  function end(why) {
    if (closed) return;
    closed = true;
    socket.destroy();
    for (const [id, p] of [...pending]) {
      pending.delete(id);
      clock.clearTimeout(p.timer);
      p.settle({ error: refusal(why) });
    }
    // a listener that keeps something from this connection (a chat list) learns it ended, however it ended
    try {
      onEvent({ event: 'connection.closed', reason: why });
    } catch (e) {
      report(e);
    }
  }
  socket.on('error', (e) => end(e.message));
  socket.on('close', () => end('The machine closed the connection.'));
  socket.on('data', (chunk) => {
    try {
      for (const f of decoder.push(chunk)) {
        if (f.kind !== 'control') continue;
        const msg = f.message;
        if (typeof msg.event === 'string') {
          try {
            onEvent(msg);
          } catch (e) {
            // a listener that fails must not drop the connection
            report(e);
          }
          continue;
        }
        const waiter = typeof msg.id === 'number' ? pending.get(msg.id) : undefined;
        if (!waiter) continue;
        pending.delete(/** @type {number} */ (msg.id));
        clock.clearTimeout(waiter.timer);
        if (msg.error !== undefined) {
          const e = msg.error;
          waiter.settle({
            error: refusal(userError(typeof e === 'string' ? e : (e?.message ?? 'The machine refused.')), e?.code ?? msg.code, {
              // what the caller needs to act on a refusal: the chat's current epoch, where a handed-over chat went
              ...(Number.isSafeInteger(msg.current) ? { current: msg.current } : {}),
              ...(msg.details && typeof msg.details === 'object' ? { details: msg.details } : {}),
            }),
          });
        } else waiter.settle({ value: msg.result });
      }
    } catch {
      end('The machine sent something this app cannot read.');
    }
  });

  /** @param {string} method @param {object} [params] @param {{ timeoutMs?: number }} [opts] @returns {Promise<any>} */
  function call(method, params, { timeoutMs = callMs } = {}) {
    if (closed) return Promise.reject(refusal('The connection to the machine is closed.'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      /** @type {any} */
      const timer =
        timeoutMs > 0
          ? clock.setTimeout(() => (pending.delete(id), reject(refusal('The machine did not answer.', 'host_unreachable'))), timeoutMs)
          : null;
      pending.set(id, { timer, settle: (r) => (r.error ? reject(r.error) : resolve(r.value)) });
      try {
        socket.write(frames.encodeControl({ id, method, params }));
      } catch (e) {
        pending.delete(id);
        clock.clearTimeout(timer);
        reject(e);
      }
    });
  }

  const ready = new Promise((resolve, reject) => {
    const timer = clock.setTimeout(
      () => (reject(refusal('The machine did not answer.', 'host_unreachable')), end('The machine did not answer.')),
      helloMs,
    );
    socket.once('connect', () => {
      authenticate((method, params) => call(method, params), identity).then(
        () => (clock.clearTimeout(timer), resolve(undefined)),
        (e) => (clock.clearTimeout(timer), reject(e), end('The machine refused this app.')),
      );
    });
    socket.once('close', () => (clock.clearTimeout(timer), reject(refusal('The machine closed the connection.'))));
  });

  return ready.then(() => ({ call, close: () => end('The connection was closed.') }));
}

module.exports = { openSession };
