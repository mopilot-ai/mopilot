// Saving a chat's meta where "the value is already what was asked" is a success: ChatsStore.patchMeta answers false both
// for a patch that changed nothing and for one that could not be saved, so a caller that raises on false needs this.

/** Whether every key in `patch` already holds that value in the chat's saved meta (the store's own comparison). */
export function metaHolds(chats, id, patch) {
  if (typeof id !== 'string' || !id || !patch || typeof patch !== 'object') return false;
  if (chats.isDeleted?.(id) === true) return false;
  const meta = chats.records.get(id)?.meta;
  if (!meta) return false;
  const keys = Object.keys(patch);
  return keys.length > 0 && keys.every((k) => JSON.stringify(meta[k]) === JSON.stringify(patch[k] === undefined ? null : patch[k]));
}

/** True when the patch is saved or was already in place; false only when it could not be saved. */
export function saveMeta(chats, id, patch) {
  return metaHolds(chats, id, patch) || chats.patchMeta(id, patch) === true;
}
