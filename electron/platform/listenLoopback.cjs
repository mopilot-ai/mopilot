// Settle a loopback server's listen attempt on success, failure or stop, ignoring callbacks from a cancelled attempt.
const { noteIgnored } = require('../ignored.cjs');
const observed = new WeakSet();
/** @param {import('node:http').Server} server @param {number} port @param {AbortSignal} signal @param {string} [name] */
function listenLoopback(server, port, signal, name = 'browser') {
  if (!observed.has(server)) {
    observed.add(server);
    // Bind errors already queued before close can arrive after cancellation. This observer lives with the server, not an attempt.
    server.on('error', (error) => noteIgnored(`receive a ${name} listener error`, error));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, ready = false) => {
      if (settled) return;
      settled = true;
      server.off('error', failed);
      signal.removeEventListener('abort', stopped);
      if (ready) resolve(error);
      else reject(error);
    };
    const failed = (error) => finish(error);
    const stopped = () => finish(new Error(`The ${name} server was stopped while opening.`));
    server.once('error', failed);
    signal.addEventListener('abort', stopped, { once: true });
    if (signal.aborted) return stopped();
    try {
      server.listen(port, '127.0.0.1', () => {
        if (settled) return;
        finish(/** @type {any} */ (server.address()).port, true);
      });
    } catch (error) {
      failed(error);
    }
  });
}
module.exports = { listenLoopback };
