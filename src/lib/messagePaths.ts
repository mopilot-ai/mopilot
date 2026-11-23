// Paths a reply names in inline code: which text may be a path, and the file or folder main finds there, kept per chat folder for 30 s and checked again when the window is focused.

import { useEffect, useSyncExternalStore } from 'react';
import { native } from './native';
import { lineSpan, type LineSpan } from './lineSpan';
import { parseRemoteCwd } from './remoteFolder';

export type { LineSpan } from './lineSpan';

export type MessagePath = { path: string; kind: 'file' | 'dir' };

/** How long a lookup stands before a newly shown path or a focused window asks main again (as Claude's app does). */
export const MESSAGE_PATH_TTL_MS = 30_000;
/** Lookups kept at most; the oldest go first. */
export const MESSAGE_PATH_MAX = 500;

/** A trailing location: `:12`, `:12:5`, `:12-20`, `#L12` / `#L12C5` or a range `#L5-L20` (as Claude's app links one). */
const LOCATION = /(?::(\d+)(?::\d+)?(?:-(\d+))?|#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?)$/;
/** "~", "/" or a drive: a path that doesn't depend on the chat's folder. */
const ROOTED = /^(?:~(?=$|[\\/])|\/|[A-Za-z]:[\\/])/;
/** A bare file name with an extension (`notes.md`, `MoPilot_film_9x16.mp4`). */
const BARE_FILE = /^[\w@][\w.@+-]*\.[A-Za-z0-9]{1,12}$/;

/**
 * The path (and line) inline code may name, or null for code that can't be one: a URL, a flag, shell syntax, prose
 * with spaces outside a rooted path. Whether anything is there is main's answer (useMessagePath).
 */
export function pathCandidate(text: string): ({ path: string } & LineSpan) | null {
  if (!text || text.length > 1024 || /[\n\r\t*?"<>|$`]/.test(text) || /^[a-z][\w+.-]*:\/\//i.test(text) || text.startsWith('-'))
    return null;
  const at = LOCATION.exec(text);
  const path = at ? text.slice(0, at.index) : text;
  const span: LineSpan = at ? lineSpan(at[1] ?? at[3], at[2] ?? at[4]) : { line: undefined };
  const rooted = ROOTED.test(path);
  if (!path || (/\s/.test(path) && !rooted)) return null;
  return rooted || /[\\/]/.test(path) || BARE_FILE.test(path) ? { path, ...span } : null;
}

type Entry = { at: number; value: MessagePath | null | undefined; pending: boolean; seq: number };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let seq = 0;

const keyOf = (path: string, cwd?: string | null) => `${cwd ?? ''}\0${path}`;
const same = (a: MessagePath | null | undefined, b: MessagePath | null) =>
  a === b || (!!a && !!b && a.path === b.path && a.kind === b.kind);

function notify() {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Keep an answer unless a later request for the same path already answered; an unchanged answer re-renders nothing. */
function store(key: string, value: MessagePath | null, asked: number) {
  const old = entries.get(key);
  if (old && old.seq > asked) return;
  const kept = old && same(old.value, value) ? (old.value as MessagePath | null) : value;
  entries.delete(key);
  entries.set(key, { at: Date.now(), value: kept, pending: false, seq: asked });
  while (entries.size > MESSAGE_PATH_MAX) entries.delete(entries.keys().next().value!);
  if (kept !== old?.value) notify();
}

/** Ask main now (a click checks the path is still there); the answer also updates every link showing it. */
export async function lookupMessagePath(path: string, cwd?: string | null): Promise<MessagePath | null> {
  // a folder on a machine is not looked up on this Mac
  if (parseRemoteCwd(cwd)) return null;
  const asked = ++seq;
  const value = await native.fs.messagePath(path, cwd ?? null);
  store(keyOf(path, cwd), value, asked);
  return value;
}

/** Ask main unless a lookup is under way or still fresh; a failed request keeps the last answer (none: nothing there). */
function ensure(path: string, cwd?: string | null) {
  if (parseRemoteCwd(cwd)) return;
  const key = keyOf(path, cwd);
  const entry = entries.get(key);
  if (entry && (entry.pending || Date.now() - entry.at < MESSAGE_PATH_TTL_MS)) return;
  const asked = ++seq;
  if (entry) entry.pending = true;
  else entries.set(key, { at: 0, value: undefined, pending: true, seq: 0 });
  native.fs.messagePath(path, cwd ?? null).then(
    (value) => store(key, value, asked),
    () => store(key, entries.get(key)?.value ?? null, asked),
  );
}

/** The file or folder `path` names in the chat's folder, or null while unknown or when nothing is there. */
export function useMessagePath(path: string | null | undefined, cwd?: string | null): MessagePath | null {
  // a path in a chat on a machine is plain text: it was not checked there, and this Mac's answer would be about another folder
  const key = path && !parseRemoteCwd(cwd) ? keyOf(path, cwd) : null;
  const value = useSyncExternalStore(subscribe, () => (key ? (entries.get(key)?.value ?? null) : null));
  useEffect(() => {
    if (!path) return;
    // a focused window may show files changed meanwhile: a lookup older than the TTL is asked again
    const refresh = () => ensure(path, cwd);
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [path, cwd]);
  return value;
}

/** Forget every lookup and listener (tests). */
export function resetMessagePaths() {
  entries.clear();
  listeners.clear();
  seq = 0;
}
