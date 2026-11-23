// Where one tool call's time went: the registry opens a collector for each call, and the code it runs adds a named span (a helper request, the user's approval, the screen check), so the operation log can show a call's non-model time. @host-portable
const { AsyncLocalStorage } = require('node:async_hooks');

/** @typedef {Record<string, [number, number]>} Phases span name -> [total ms, count] */

/** @type {AsyncLocalStorage<Phases>} */
const store = new AsyncLocalStorage();

/**
 * Runs `fn` with `phases` as the collector of the spans it adds, however deep the awaits go.
 * @template T
 * @param {Phases} phases
 * @param {() => T} fn
 * @returns {T}
 */
function within(phases, fn) {
  return store.run(phases, fn);
}

/**
 * Adds `ms` to the span `name` of the running call; nothing happens outside a call.
 * @param {string} name
 * @param {number} ms
 */
function note(name, ms) {
  const phases = store.getStore();
  if (!phases || !Number.isFinite(ms) || ms < 0) return;
  const was = phases[name] ?? [0, 0];
  phases[name] = [Math.round((was[0] + ms) * 10) / 10, was[1] + 1];
}

/**
 * Runs `fn` and adds how long it took (also when it rejects) as the span `name`.
 * @template T
 * @param {string} name
 * @param {() => T | Promise<T>} fn
 * @param {() => number} [now]
 * @returns {Promise<T>}
 */
async function span(name, fn, now = performance.now.bind(performance)) {
  const start = now();
  try {
    return await fn();
  } finally {
    note(name, now() - start);
  }
}

module.exports = { within, note, span };
