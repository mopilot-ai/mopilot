// Tells every listener of a connection event, one at a time: a listener that throws is reported and the ones after it still hear the event.
const { noteIgnored } = require('../ignored.cjs');

/**
 * @template T
 * @param {Iterable<(arg: T) => void>} listeners
 * @param {T} arg
 * @param {string} what what the event is, for the report of a listener that threw
 */
function fanOut(listeners, arg, what) {
  for (const fn of [...listeners]) {
    try {
      fn(arg);
    } catch (error) {
      noteIgnored(`tell a listener of a Host connection about ${what}`, error);
    }
  }
}

module.exports = { fanOut };
