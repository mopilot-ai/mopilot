// Several main-process services sharing one ChatController hook (onFinished, beforeDispatch, ...) without replacing each other.

const { noteIgnored } = require('../ignored.cjs');

const thenable = (value) => !!value && typeof value.then === 'function';

/**
 * Adds a hook beside the one already there (a turn finished, a Stop, a crash). Both always run, the earlier first. A
 * failure of either is the hook's failure, as it was with one: the first error thrown is thrown once both have run,
 * and a rejection of either rejects. The result is the earlier hook's (a promise when either returned one).
 * @param {Record<string, any>} target the controller
 * @param {string} name the hook's property name
 * @param {(...args: any[]) => unknown} hook
 */
function addHook(target, name, hook) {
  const previous = typeof target[name] === 'function' ? target[name] : null;
  target[name] = (...args) => {
    const results = [];
    /** @type {{ error: unknown } | null} */
    let thrown = null;
    for (const fn of previous ? [previous, hook] : [hook]) {
      try {
        results.push(fn(...args));
      } catch (error) {
        thrown ??= { error };
      }
    }
    if (thrown) {
      // the other hook's promise still settles: its failure is noted, not left unhandled
      for (const r of results) if (thenable(r)) r.then(undefined, (error) => noteIgnored(`run the ${name} hook`, error));
      throw thrown.error;
    }
    return results.some(thenable) ? Promise.all(results).then((values) => values[0]) : results[0];
  };
}

/**
 * Adds a step to a guard hook (beforeDispatch, onDispatchResult): the step already there runs first, and the added
 * one runs only once it succeeded. A failure of either one is the hook's failure, as it was before the second was added.
 * @param {Record<string, any>} target the controller
 * @param {string} name the hook's property name
 * @param {(...args: any[]) => unknown} step
 */
function addGuard(target, name, step) {
  const previous = typeof target[name] === 'function' ? target[name] : null;
  target[name] = async (...args) => {
    const result = previous ? await previous(...args) : undefined;
    await step(...args);
    return result;
  };
}

module.exports = { addHook, addGuard };
