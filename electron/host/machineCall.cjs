// One request to a remote machine through its own tunnel (the pool's SSH tunnel, or its path tunnel with a relay): the tunnel is
// leased only while the request runs, and one that does not come up in time is a refusal saying why.
const { clock } = require('../platform/ports/clock.cjs');
const { requestOverSocket, CALL_MS } = require('./hostRequest.cjs');

/** A refusal from the Host or the tunnel, with the Host's `code` when it sent one. @param {string} message @param {string} [code] */
const refusal = (message, code) => Object.assign(new Error(message), code ? { code } : {});

/**
 * @param {object} o
 * @param {{ get: (target: any) => any }} o.pool
 * @param {(record: any) => any} o.targetOf the tunnel's target for a record
 * @param {{ enrolled: (address: string) => boolean } | null} o.relay
 * @param {(socketPath: string) => import('node:net').Socket} o.connect
 */
function createMachineCall({ pool, targetOf, relay, connect }) {
  /** The tunnel to a machine once it is up, held until the caller releases it; throws when it does not come up in time. @param {{ address: string, socketPath: string, identity?: string }} record */
  async function lease(record) {
    // a record without a socket is never given one by guessing (the registry holds what the Host said)
    if (!record.socketPath) throw refusal('This machine has no Host socket on record.');
    const tunnel = pool.get(targetOf(record));
    const held = tunnel.acquire();
    let timer;
    const up = await Promise.race([
      held.ready,
      new Promise((resolve) => {
        timer = clock.setTimeout(() => resolve(false), CALL_MS);
      }),
    ]).finally(() => clock.clearTimeout(timer));
    if (!up) {
      held.release();
      const why = relay?.enrolled(record.address) ? /** @type {any} */ (tunnel).reason || 'Could not reach the machine.' : '';
      // a machine the tunnel does not reach is unreachable for whoever asked: the Switch host dialog says so and offers the retry (Remote Run #5197)
      throw refusal(why || 'Could not reach the machine over SSH.', 'host_unreachable');
    }
    return held;
  }
  /** One request to a machine; the tunnel stays up only while the request does. @param {{ id: string, address: string, socketPath: string }} record @param {string} method @param {object} [params] */
  async function call(record, method, params) {
    const held = await lease(record);
    try {
      return await requestOverSocket(held, method, params, connect);
    } finally {
      held.release();
    }
  }
  return { lease, call };
}

module.exports = { createMachineCall, refusal };
