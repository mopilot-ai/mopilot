// Caches a pure function's result per object: a finished turn or reply keeps its identity in the store, so work over a
// long thread is done once per turn instead of once per update.

/** `fn` wrapped so each object it is called with computes once; an object that is no longer referenced is let go. */
export function memoByObject<K extends object, V>(fn: (key: K) => V): (key: K) => V {
  const cache = new WeakMap<K, V>();
  return (key) => {
    if (cache.has(key)) return cache.get(key) as V;
    const value = fn(key);
    cache.set(key, value);
    return value;
  };
}
