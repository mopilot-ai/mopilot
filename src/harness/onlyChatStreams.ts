// Whether a store write only moved chats' runtime entries, so listeners that read nothing in them can skip it.

/**
 * A write that only moved chats' runtime (a streamed delta) changes nothing a limit offer reads: usage, accounts and
 * pins are other slices, and a chat's own entry in `runtime` is read only for being there. A chat added or dropped
 * still checks.
 */
export function onlyChatStreams<S extends { runtime: Record<string, unknown> }>(s: S, prev: S) {
  if (s.runtime === prev.runtime) return false;
  for (const k in s) if (k !== 'runtime' && s[k] !== prev[k]) return false;
  const a = s.runtime;
  const b = prev.runtime;
  for (const id in a) if (!(id in b)) return false;
  for (const id in b) if (!(id in a)) return false;
  return true;
}
