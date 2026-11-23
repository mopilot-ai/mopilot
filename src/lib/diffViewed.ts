// Viewed marks in the Changes pane: one storage entry per diff scope and file, so independent windows never overwrite each other's marks.
import { useSyncExternalStore } from 'react';
import { noteIgnored } from './ignored';

export const VIEWED_STORAGE_PREFIX = 'mopilot.changes.viewed.v1/';
export const VIEWED_FOLDERS_MAX = 30;
export const VIEWED_FILES_MAX = 500;
export type ViewedState = 'viewed' | 'changed' | null;
type Marks = Map<string, Map<string, string>>;
let marks: Marks | null = null;
const listeners = new Set<() => void>();
let version = 0;
let watchingStorage = false;
const keyOf = (root: string, path: string) => VIEWED_STORAGE_PREFIX + JSON.stringify([root, path]);

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch (error) {
    noteIgnored('reach local storage for Viewed marks', error);
    return null;
  }
}

function read(): Marks {
  const saved: Marks = new Map();
  try {
    const store = storage();
    if (!store) return saved;
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key?.startsWith(VIEWED_STORAGE_PREFIX)) continue;
      try {
        const identity: unknown = JSON.parse(key.slice(VIEWED_STORAGE_PREFIX.length));
        const value = store.getItem(key);
        if (!Array.isArray(identity) || identity.length !== 2 || !identity.every((v) => typeof v === 'string') || value === null) continue;
        const [root, path] = identity;
        if (!saved.has(root)) saved.set(root, new Map());
        saved.get(root)!.set(path, value);
      } catch (error) {
        noteIgnored('read a Viewed mark', error);
      }
    }
  } catch (error) {
    noteIgnored('read the Viewed marks', error);
  }
  return saved;
}

const load = () => (marks ??= read());
function changed() {
  version++;
  for (const listener of [...listeners]) listener();
}

export function viewedState(root: string, path: string, fingerprint: string): ViewedState {
  const mark = load().get(root)?.get(path);
  return mark === undefined ? null : mark === fingerprint ? 'viewed' : 'changed';
}

/** Each write touches one file's key; eviction removes only entries beyond the retention limits. */
export function setViewed(root: string, path: string, fingerprint: string | null) {
  const all = load();
  const files = all.get(root) ?? new Map<string, string>();
  files.delete(path);
  if (fingerprint !== null) files.set(path, fingerprint);
  all.delete(root);
  if (files.size) all.set(root, files);
  try {
    const store = storage();
    const key = keyOf(root, path);
    if (fingerprint === null) store?.removeItem(key);
    else store?.setItem(key, fingerprint);
    for (const [scope, entries] of all) {
      const excess = all.size > VIEWED_FOLDERS_MAX ? entries.size : Math.max(0, entries.size - VIEWED_FILES_MAX);
      for (const old of [...entries.keys()].slice(0, excess)) {
        entries.delete(old);
        store?.removeItem(keyOf(scope, old));
      }
      if (!entries.size) all.delete(scope);
    }
  } catch (error) {
    noteIgnored('save the Viewed marks', error);
  }
  changed();
}

function onStorage(event: StorageEvent) {
  if (event.key !== null && !event.key.startsWith(VIEWED_STORAGE_PREFIX)) return;
  marks = null;
  changed();
}
function subscribe(listener: () => void) {
  // Keep the cache current while the pane is closed too; storage events cannot be replayed on reopening.
  if (!watchingStorage) {
    window.addEventListener('storage', onStorage);
    watchingStorage = true;
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useViewedVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
/** Forget the in-memory snapshot; the next read loads storage again. */
export function resetViewedMarks() {
  marks = null;
  changed();
}
