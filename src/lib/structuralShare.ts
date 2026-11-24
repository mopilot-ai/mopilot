// Keeping what did not change: a broadcast from main replaces a whole view, and a reader of one part of it must not render for the rest (#5398).

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * `next` with every part equal to the same place in `prev` replaced by that part, so an object a component holds keeps its
 * identity until its own content changes; `prev` itself when nothing changed. Both are JSON read from main (no cycles,
 * no classes); a value of another kind is taken as it is.
 */
export function shareDeep<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return next;
  // nothing is allocated until the first difference: a view that did not change (most broadcasts) is only walked
  if (Array.isArray(next) && Array.isArray(prev)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < next.length; i++) {
      const shared = shareDeep(prev[i], next[i]);
      if (!out && shared !== prev[i]) out = prev.slice(0, i);
      if (out) out[i] = shared;
    }
    // the same elements, fewer or more of them
    if (!out && prev.length !== next.length) out = Array.from(next, (item, i) => prev[i] ?? item);
    return (out ?? prev) as T;
  }
  if (isRecord(next) && isRecord(prev)) {
    const keys = Object.keys(next);
    let out: Json | null = null;
    for (let at = 0; at < keys.length; at++) {
      const key = keys[at];
      const shared = shareDeep(prev[key], next[key]);
      if (!out && (!Object.hasOwn(prev, key) || shared !== prev[key])) {
        out = {};
        for (let before = 0; before < at; before++) out[keys[before]] = prev[keys[before]];
      }
      if (out) out[key] = shared;
    }
    if (!out && keys.length !== Object.keys(prev).length) {
      out = {};
      for (const key of keys) out[key] = prev[key];
    }
    return (out ?? prev) as T;
  }
  return next;
}
