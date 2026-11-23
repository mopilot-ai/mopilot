// One request to a Host over a fresh socket through its tunnel, and the answer: the registry's heartbeat and pairing use it (machines.cjs), outside any chat connection.
const { clock } = require('../platform/ports/clock.cjs');
const frames = require('../../shared/host/frames.mjs');

/** How long one request over a tunnel may take. */
const CALL_MS = 15_000;

/** A refusal from the Host or the tunnel, with the Host's `code` when it sent one. @param {string} message @param {string} [code] */
const refusal = (message, code) => Object.assign(new Error(message), code ? { code } : {});

/**
 * One request to a Host through its tunnel and the answer: resolves the result, rejects with the Host's error and code.
 * @param {{ socketPath: string }} lease
 * @param {string} method @param {object | undefined} params
 * @param {(socketPath: string) => import('node:net').Socket} connect
 */
function requestOverSocket(lease, method, params, connect) {
  return new Promise((resolve, reject) => {
    const socket = connect(lease.socketPath);
    const decoder = frames.createDecoder();
    let done = false;
    /** @param {(v: any) => void} settle @param {any} v */
    const finish = (settle, v) => {
      if (done) return;
      done = true;
      clock.clearTimeout(guard);
      socket.destroy();
      settle(v);
    };
    const guard = clock.setTimeout(() => finish(reject, refusal('The machine did not answer.', 'host_unreachable')), CALL_MS);
    socket.on('error', (e) => finish(reject, refusal(e.message)));
    socket.on('close', () => finish(reject, refusal('The machine closed the connection.')));
    socket.once('connect', () => socket.write(frames.encodeControl({ id: 1, method, params })));
    socket.on('data', (chunk) => {
      try {
        for (const f of decoder.push(chunk)) {
          if (f.kind !== 'control' || f.message.id !== 1) continue;
          if (f.message.error !== undefined) {
            const e = f.message.error;
            return finish(
              reject,
              refusal(typeof e === 'string' ? e : String(e?.message ?? 'The machine refused.'), e?.code ?? f.message.code),
            );
          }
          return finish(resolve, f.message.result);
        }
      } catch {
        finish(reject, refusal('The machine sent something this app cannot read.'));
      }
    });
  });
}

module.exports = { requestOverSocket, CALL_MS };
