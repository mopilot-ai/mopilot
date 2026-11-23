// What a mirror request needs before it runs: the device is enabled for mirrors on this Mac and follows the chat it names.
const { RemoteError } = require('./serviceErrors.cjs');

/** Whether the Mac turned mirrors on for this device (off unless the policy says so). */
const enabled = (/** @type {any} */ svc, /** @type {any} */ client) => svc.policy.mirrors?.(client.pairId) === true;

/** Throws unless the device may mirror `chatId` now: enabled, wired on this Mac, and following the chat. */
function assertMirror(/** @type {any} */ svc, /** @type {any} */ client, /** @type {string} */ chatId) {
  if (!svc.ops.mirror) throw new RemoteError('failed', "This Mac can't mirror that right now.");
  if (!enabled(svc, client)) throw new RemoteError('forbidden', 'Mirroring is off for this device on this Mac.');
  if (!client.follows.has(chatId)) throw new RemoteError('forbidden', 'Follow this chat first.');
}

/** Whether `assertMirror` would pass, for a mirror that is already running (a revoked device or an unfollowed chat ends it). */
function stillAllowed(/** @type {any} */ svc, /** @type {any} */ client, /** @type {string} */ chatId) {
  try {
    assertMirror(svc, client, chatId);
    return svc.paired(client);
  } catch {
    return false;
  }
}

module.exports = { assertMirror, stillAllowed, enabled };
