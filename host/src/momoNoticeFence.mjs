// A store whose named writes ask first whether this Host is still the running home, so a pass or a reminder that outlives its lease writes nothing more (host/src/momoNotice.mjs).

/**
 * `target` with the named methods refusing, before they run, once the lease is no longer the home's.
 * @template {object} T @param {T} target @param {string[]} names @param {() => Promise<void>} check @returns {T}
 */
export const fenced = (target, names, check) =>
  new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key);
      if (typeof key !== 'string' || !names.includes(key) || typeof value !== 'function') return value;
      return async (/** @type {any[]} */ ...args) => {
        await check();
        return value.apply(object, args);
      };
    },
  });
