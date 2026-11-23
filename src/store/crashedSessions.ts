// Which sessions a store write newly crashed: only the entries the write replaced are looked at, not every chat's.

type Sessions = Record<string, { turn?: string; crashed?: string | null } | undefined>;

/** Calls `onCrashed` once for each session that turned 'crashed' between `prev` and `st`. */
export function eachNewlyCrashed(st: Sessions, prev: Sessions, onCrashed: (id: string, why: string | null) => void) {
  if (st === prev) return;
  for (const id in st) {
    const s = st[id];
    if (s !== prev[id] && s?.turn === 'crashed' && prev[id]?.turn !== 'crashed') onCrashed(id, s.crashed ?? null);
  }
}
