// Excludes a linked-session merge from the parent chat's turn starts.
/** @type {WeakMap<object, Map<string, Promise<void>>>} */
const held = new WeakMap();

function locks(controller) {
  let map = held.get(controller);
  if (!map) held.set(controller, (map = new Map()));
  return map;
}

function folderMutation(controller, chatId) {
  return locks(controller).get(chatId) ?? null;
}

/** @param {(() => unknown) | null} [onRelease] runs after the lock is released */
function acquireFolderMutation(controller, chatId, onRelease = null) {
  const map = locks(controller);
  if (map.has(chatId) || controller.state.get(chatId).turn !== 'idle') return null;
  /** @type {any} assigned by the promise executor, which runs synchronously */
  let resolve;
  const waiting = /** @type {Promise<void>} */ (new Promise((done) => (resolve = done)));
  map.set(chatId, waiting);
  return () => {
    map.delete(chatId);
    resolve();
    onRelease?.();
  };
}

module.exports = { folderMutation, acquireFolderMutation };
