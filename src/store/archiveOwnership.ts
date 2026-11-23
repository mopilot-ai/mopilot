// Renderer-local archive effects serialize per chat; snapshots reject intervening mutations without cancelling independent writes.
let read = 0;
let revision = 0;
let mutations = 0;
const changes = new Map<string, Promise<unknown>>();
const visibilityReads = new Set<Set<string>>();

/** A list may combine unrelated chats, but must not reinsert a chat deleted while it was read. */
export function beginThreadVisibilityRead() {
  const deleted = new Set<string>();
  visibilityReads.add(deleted);
  return {
    allows: (id: string) => !deleted.has(id),
    finish: () => {
      visibilityReads.delete(deleted);
    },
  };
}

/** A successful local whole-chat delete retires this id from in-flight lists; repeated deletes are idempotent. */
export function recordThreadDeletion(id: string) {
  for (const deleted of visibilityReads) deleted.add(id);
}

export function beginArchiveRead() {
  const own = ++read;
  const before = revision;
  return () => own === read && before === revision && mutations === 0;
}

export async function mutateArchive<T>(threadId: string, change: () => Promise<T>): Promise<T> {
  revision++;
  mutations++;
  const previous = changes.get(threadId);
  const pending = (async () => {
    // Same-chat effects retain request order even after failure; different chats remain concurrent.
    if (previous !== undefined) await Promise.allSettled([previous]);
    return change();
  })();
  changes.set(threadId, pending);
  try {
    return await pending;
  } finally {
    if (changes.get(threadId) === pending) changes.delete(threadId);
    mutations--;
    revision++;
  }
}
