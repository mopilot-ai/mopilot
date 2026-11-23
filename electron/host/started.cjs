// The short-lived programs Host starts and waits on (a Bonjour browse, `ssh -G`, an install step over ssh, ssh-keygen): each is stopped when the app quits, so none outlives it. A browse never ends by itself, and an orphan keeps the pipes it inherited open.

/** @typedef {{ kill: (signal?: NodeJS.Signals) => unknown, once: (event: 'close', fn: () => void) => unknown }} Started */

/** @type {Set<Started>} */
const running = new Set();

/** Follows `child` until it ends; returns it. @template {Started} T @param {T} child @returns {T} */
function track(child) {
  running.add(child);
  child.once('close', () => running.delete(child));
  return child;
}

/** Stops every program still running (the app is quitting). */
function stopAll() {
  for (const child of running) child.kill('SIGTERM');
  running.clear();
}

/** How many are still running (for tests). */
const count = () => running.size;

module.exports = { track, stopAll, count };
