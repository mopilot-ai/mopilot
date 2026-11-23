// One quota status per uninterrupted episode, owned by the displayed history across reloads and live turn adoption.
const isLimit = (item) => item.type === 'statusNote' && item.kind === 'limit';
const resetsLimit = (item) =>
  item.type === 'statusNote' ? ['switch', 'account', 'model'].includes(item.kind) : item.type !== 'hookPrompt' && !item.synthetic;

/** Resolve a new limit against current displayed state, never a translator's retired turn identity. */
export function limitNoteHome(turns, turnId, item) {
  if (isLimit(item)) {
    for (let t = turns.length - 1; t >= 0; t--) {
      const items = turns[t].items ?? [];
      for (let i = items.length - 1; i >= 0; i--) {
        const before = items[i];
        if (isLimit(before)) return { turnId: turns[t].id, item: { ...item, id: before.id } };
        if (resetsLimit(before)) return { turnId, item };
      }
    }
  }
  return { turnId, item };
}

/** Reconcile an early live notice copied into a replayed turn; ordinary history keeps its original references. */
export function coalesceLimitNotes(turns) {
  const out = [];
  let home = null;
  let changed = false;
  for (const turn of turns) {
    const next = { ...turn, items: [] };
    out.push(next);
    for (const item of turn.items ?? []) {
      if (isLimit(item)) {
        if (home) {
          home.turn.items[home.index] = { ...item, id: home.turn.items[home.index].id };
          changed = true;
          continue;
        }
        home = { turn: next, index: next.items.length };
      } else if (resetsLimit(item)) home = null;
      next.items.push(item);
    }
  }
  return changed ? out : turns;
}
