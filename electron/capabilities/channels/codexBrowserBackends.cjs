// Keep optional browser-backend lifecycle failures out of Codex app-server traffic, report settled loads, and read whether a thread has a backend.
const { noteIgnored } = require('../../ignored.cjs');

function callBackends(backends, action, settled) {
  if (!backends) return;
  const failed = (error) => noteIgnored('start the browser backends for a native Codex thread', error);
  try {
    Promise.resolve(action(backends)).then(settled).catch(failed);
  } catch (error) {
    failed(error);
  }
}

/** Whether `backends` holds one for `threadId`: false without them, or when they can't say. */
function hasBackend(backends, threadId) {
  try {
    return backends?.has(threadId) === true;
  } catch {
    return false;
  }
}

module.exports = { callBackends, hasBackend };
