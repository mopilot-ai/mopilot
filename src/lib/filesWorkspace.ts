// The Files pane's workspace per folder, window-local: the files open as its tabs, the one in front with its cited lines, whether the tree shows, and the last "Reveal in file tree".

import { useSyncExternalStore } from 'react';
import type { LineSpan } from './lineSpan';

export type FilesWorkspace = {
  /** files open as the pane's tabs, in the order they were opened */
  open: readonly string[];
  active: string | null;
  /** the lines the front file was opened at (a search result, a reveal) */
  span: LineSpan;
  /** each open request, so opening the file already in front at the same line still scrolls to it */
  seq: number;
  tree: boolean;
  /** the file the tree shows and scrolls to, with the request it came from and when it was asked */
  reveal: { path: string; seq: number; at: number } | null;
};

const EMPTY: FilesWorkspace = { open: [], active: null, span: {}, seq: 0, tree: true, reveal: null };
const spaces = new Map<string, FilesWorkspace>();
const listeners = new Set<() => void>();
let seq = 0;

/** Folders kept at most; the least recently changed goes first. */
export const FILES_WORKSPACES_MAX = 50;

function write(cwd: string, next: FilesWorkspace) {
  spaces.delete(cwd);
  spaces.set(cwd, next);
  while (spaces.size > FILES_WORKSPACES_MAX) spaces.delete(spaces.keys().next().value!);
  for (const listener of [...listeners]) listener();
}

export const filesWorkspace = (cwd: string): FilesWorkspace => spaces.get(cwd) ?? EMPTY;

/**
 * Open `path` as a tab (or bring its tab to the front), at `span` when given. The file already in front, asked for
 * without lines (its tab or tree row clicked again), stays as it is: its editor, caret and scroll.
 */
export function openWorkspaceFile(cwd: string, path: string, span: LineSpan = {}) {
  const s = filesWorkspace(cwd);
  if (s.active === path && span.line === undefined) return;
  const open = s.open.includes(path) ? s.open : [...s.open, path];
  write(cwd, { ...s, open, active: path, span, seq: ++seq });
}

/**
 * Close `path`'s tab: the tab after it takes the front (the one before for the last), and the pane shows the tree
 * again once nothing is open.
 */
export function closeWorkspaceFile(cwd: string, path: string) {
  const s = filesWorkspace(cwd);
  const at = s.open.indexOf(path);
  if (at < 0) return;
  const open = s.open.filter((p) => p !== path);
  const active = s.active === path ? (open[at] ?? open[at - 1] ?? null) : s.active;
  write(cwd, { ...s, open, active, span: s.active === path ? {} : s.span, tree: open.length ? s.tree : true });
}

export function setWorkspaceTree(cwd: string, tree: boolean) {
  const s = filesWorkspace(cwd);
  if (s.tree !== tree) write(cwd, { ...s, tree });
}

/** Show the tree with `path`'s folders expanded and its row scrolled to. */
export function revealInFileTree(cwd: string, path: string) {
  write(cwd, { ...filesWorkspace(cwd), tree: true, reveal: { path, seq: ++seq, at: Date.now() } });
}

/** How long a reveal applies: the folders and row it names act on it as they appear, not when shown again later. */
export const REVEAL_MS = 2000;
export const revealing = (reveal: FilesWorkspace['reveal']) => !!reveal && Date.now() - reveal.at < REVEAL_MS;

/** Whether a folder's Files tabs other than `except`'s hold `path` (closing one view of a file then keeps its edit). */
export function workspacesShowing(path: string, except: string): boolean {
  return [...spaces].some(([cwd, s]) => cwd !== except && s.open.includes(path));
}

/** Tests: start from no workspaces. */
export function resetFilesWorkspaces() {
  spaces.clear();
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useFilesWorkspace(cwd: string): FilesWorkspace {
  return useSyncExternalStore(subscribe, () => filesWorkspace(cwd));
}
