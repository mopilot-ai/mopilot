// Unsaved edits to files in the side pane, keyed by path: kept while the file's tab is hidden or another chat shows, saved on this device so a quit, reload or another window keeps them, written over the file only when it still holds what the edit started from (or the user says to), and given up only when the user agrees.

import { useSyncExternalStore } from 'react';
import { native } from './native';
import { errorText, noteIgnored } from './ignored';

/** `base`: the file's text when editing began; `text`: the edit. A draft equal to its base is no draft. */
export type FileDraft = { base: string; text: string };
export type SaveResult = 'saved' | 'kept' | 'busy' | 'discarded';

const KEY = 'mopilot.fileDrafts.v1';
/** The most text the saved drafts hold (local storage's room is a few megabytes); a draft past it lives in memory only. */
export const SAVED_DRAFTS_MAX_CHARS = 4_000_000;

let drafts: Map<string, FileDraft> | null = null;
const saving = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of [...listeners]) listener();
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch (error) {
    noteIgnored('reach local storage for file drafts', error);
    return null;
  }
}

/** The saved drafts; unreadable or malformed ones read as none. */
function readSaved(): Record<string, FileDraft> {
  const out: Record<string, FileDraft> = {};
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(KEY) ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      for (const [path, d] of Object.entries(parsed as Record<string, unknown>)) {
        const draft = d as Partial<FileDraft> | null;
        if (typeof draft?.base === 'string' && typeof draft.text === 'string' && draft.base !== draft.text)
          out[path] = { base: draft.base, text: draft.text };
      }
  } catch (error) {
    noteIgnored('read the saved file drafts', error);
  }
  return out;
}

function all(): Map<string, FileDraft> {
  drafts ??= new Map(Object.entries(readSaved()));
  return drafts;
}

/**
 * Save `path`'s draft (null: its removal) over what storage holds now, so another window's drafts of other files stay.
 * A failed write leaves the draft in this window only.
 */
function persist(path: string, draft: FileDraft | null) {
  const saved = readSaved();
  delete saved[path];
  if (draft) saved[path] = draft;
  let json = JSON.stringify(saved);
  if (json.length > SAVED_DRAFTS_MAX_CHARS && draft) {
    delete saved[path];
    json = JSON.stringify(saved);
  }
  try {
    storage()?.setItem(KEY, json);
  } catch (error) {
    noteIgnored('save the file drafts', error);
  }
}

function put(path: string, draft: FileDraft | null) {
  if (draft) all().set(path, draft);
  else all().delete(path);
  persist(path, draft);
  notify();
}

export const fileDraft = (path: string): FileDraft | undefined => all().get(path);
export const hasDraft = (path: string) => all().has(path);

/** `text` with the line endings `base` uses: an editor field reads every ending as \n, and saving must not change them. */
export function withEndingsOf(base: string, text: string): string {
  return base.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text;
}

/** Record the edit of `path` begun from `base`, in `base`'s line endings; an edit back to `base` drops the draft. */
export function setFileDraft(path: string, base: string, edited: string) {
  const text = withEndingsOf(base, edited);
  const old = all().get(path);
  if (text === base) {
    if (old) put(path, null);
    return;
  }
  if (old?.base === base && old.text === text) return;
  put(path, { base, text });
}

export function dropFileDraft(path: string) {
  if (all().has(path)) put(path, null);
}

/**
 * Whether the edits of `paths` may go (the user agreed, or none of them has one); agreeing drops them. `ask` is the
 * window's confirm, so tests answer it.
 */
export function confirmDiscard(paths: readonly string[], ask: (message: string) => boolean = (m) => window.confirm(m)): boolean {
  const unsaved = paths.filter(hasDraft);
  if (!unsaved.length) return true;
  const what = unsaved.length === 1 ? 'this file' : `${unsaved.length} files`;
  if (!ask(`Discard unsaved changes to ${what}? Your edits will be lost. What's already saved stays saved.`)) return false;
  for (const path of unsaved) put(path, null);
  return true;
}

/**
 * Save `path`'s draft. The file is read first: when it no longer holds the draft's base (an agent or another app wrote
 * it meanwhile), the user is asked before their version replaces it, and saying no keeps the draft ('kept'). A draft
 * discarded while the file was read is not written ('discarded'). A save already under way for the path makes this one
 * 'busy'. A failed read or write rejects with its reason, and the draft stays for another try. An edit typed while the
 * save ran stays a draft, against what was saved.
 */
export async function saveFileDraft(path: string, ask: (message: string) => boolean = (m) => window.confirm(m)): Promise<SaveResult> {
  const draft = all().get(path);
  if (!draft) return 'saved';
  if (saving.has(path)) return 'busy';
  saving.add(path);
  notify();
  const settle = () => {
    saving.delete(path);
    notify();
  };
  return writeDraft(path, draft, ask).then(
    (result) => (settle(), result),
    (error) => {
      settle();
      throw new Error(errorText(error) || 'Could not save the file');
    },
  );
}

async function writeDraft(path: string, draft: FileDraft, ask: (message: string) => boolean): Promise<SaveResult> {
  const disk = await native.fs.readText(path);
  if (!all().has(path)) return 'discarded';
  if (disk !== draft.base && !ask('This file changed since you started editing it. Save your version over the changes?')) return 'kept';
  const result = await native.fs.writeText(path, draft.text);
  if (!result.ok) throw new Error(result.error || 'Could not save the file');
  // what is now on disk is the base of whatever was typed since the save began
  const now = all().get(path);
  if (now) setFileDraft(path, draft.text, now.text);
  return 'saved';
}

export const isSavingDraft = (path: string) => saving.has(path);

/** Another window saved, changed or dropped a draft: read the saved drafts again. */
function onStorage(event: StorageEvent) {
  if (event.key !== KEY) return;
  drafts = null;
  notify();
}

/** Tests: forget what was read (the next read is from storage) and any save under way. */
export function resetFileDrafts() {
  drafts = null;
  saving.clear();
  notify();
}

function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('storage', onStorage);
  };
}

/** `path`'s draft and whether it is being saved, kept current. */
export function useFileDraft(path: string): { draft: FileDraft | undefined; saving: boolean } {
  const draft = useSyncExternalStore(subscribe, () => all().get(path));
  const busy = useSyncExternalStore(subscribe, () => saving.has(path));
  return { draft, saving: busy };
}
