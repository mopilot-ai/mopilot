// Live previews share per-path controls and revisions; committed keys synchronize across windows, failed edits remain while open.
import { canvasStoragePrefix, readCanvasState, saveCanvasValue, serializeCanvasValue } from './persistence';
type Snapshot = { state: Record<string, unknown>; revision: number; notice: string };
type Listener = (snapshot: Snapshot) => void;
const owners = new WeakMap<Storage, Map<string, ReturnType<typeof createOwner>>>();

function createOwner(path: string, storage: Storage) {
  let state: Record<string, unknown> = {};
  let revision = 0;
  let notice = '';
  const unsaved = new Map<string, unknown>();
  const listeners = new Set<Listener>();
  const snapshot = () => ({ state, revision, notice });
  const notify = () => {
    for (const listener of listeners) listener(snapshot());
  };
  const refresh = (publish = true) => {
    let warning = '';
    let saved = state;
    try {
      saved = readCanvasState(storage, path, () => {
        warning = 'Some saved controls could not be read. Their original data was preserved.';
      });
    } catch {
      warning = 'Saved controls could not be read. The canvas opened with its defaults.';
    }
    const next = { ...saved, ...Object.fromEntries(unsaved) };
    const nextNotice = unsaved.size ? 'Your changes are visible here, but could not be saved for reopening.' : warning;
    if (JSON.stringify(next) !== JSON.stringify(state) || nextNotice !== notice) {
      state = next;
      notice = nextNotice;
      revision++;
      if (publish) notify();
    }
    return snapshot();
  };
  const receive = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== storage) return;
    if (event.key === null || event.key.startsWith(canvasStoragePrefix(path))) refresh();
  };
  window.addEventListener('storage', receive);
  return {
    users: 0,
    read: refresh,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(key: string, value: unknown) {
      serializeCanvasValue(key, value);
      refresh(false);
      state = { ...state, [key]: value };
      revision++;
      try {
        saveCanvasValue(storage, path, key, value);
        unsaved.delete(key);
      } catch {
        unsaved.set(key, value);
      }
      refresh(false);
      notify();
    },
    dispose() {
      window.removeEventListener('storage', receive);
    },
  };
}

export function retainCanvasState(path: string, storage: Storage) {
  let paths = owners.get(storage);
  if (!paths) {
    paths = new Map();
    owners.set(storage, paths);
  }
  let owner = paths.get(path);
  if (!owner) {
    owner = createOwner(path, storage);
    paths.set(path, owner);
  }
  owner.users++;
  return {
    read: owner.read,
    set: owner.set,
    subscribe: owner.subscribe,
    release() {
      owner.users--;
      if (!owner.users) {
        owner.dispose();
        paths.delete(path);
      }
    },
  };
}
