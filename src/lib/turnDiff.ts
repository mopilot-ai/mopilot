// The files a turn changed, from its aggregate diff or its file change items, and the Changes panel's scope.

import type { TurnState } from '../../shared/model/store';
import { fileChangeToDiff, parseUnifiedDiff, type DiffFile } from './diff';
import { mergeDiffFile } from './diffMerge';
import { isAbsolutePath, isUnder } from './paths';

/**
 * The aggregate diff is authoritative; item patches are a fallback for older turns and folders without one. Only applied
 * edits count (an edit still awaiting approval is in progress), and with `cwd` only those inside the chat's folder (a
 * Claude plan file lives in app data).
 */
export function turnDiffFiles(turn: Pick<TurnState, 'diff' | 'items'>, cwd?: string | null): DiffFile[] {
  if (turn.diff !== undefined) return parseUnifiedDiff(turn.diff);
  const files = new Map<string, DiffFile>();
  for (const item of turn.items) {
    if (item.type !== 'fileChange' || item.status !== 'completed') continue;
    for (const change of item.changes) {
      if (!change.path || (cwd && !inFolder(change.path, cwd))) continue;
      const file = fileChangeToDiff(change);
      const previous = files.get(file.path);
      files.set(file.path, previous ? mergeDiffFile(previous, file) : file);
    }
  }
  return [...files.values()];
}

/** A relative path is the folder's unless it climbs out of it. */
function inFolder(path: string, cwd: string) {
  return isAbsolutePath(path) ? isUnder(path, cwd) : !/^\.\.(?:[\\/]|$)/.test(path);
}

/** What a turn leaves on disk now: nothing once its edits were undone. */
export function changedFiles(turn: Pick<TurnState, 'diff' | 'items' | 'undone'>, cwd?: string | null): DiffFile[] {
  return turn.undone ? [] : turnDiffFiles(turn, cwd);
}

/** An explicit turn never falls back to an unrelated turn. */
export function lastTurnDiffFiles(turns: TurnState[], turnId?: string, cwd?: string | null): DiffFile[] {
  if (turnId) {
    const turn = turns.find((t) => t.id === turnId);
    return turn ? changedFiles(turn, cwd) : [];
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    const files = changedFiles(turns[i], cwd);
    if (files.length) return files;
  }
  return [];
}

/** The ids of a chat's turns, newest first, or the one turn asked for. */
export const turnIdsOf = (turns: readonly { id: string }[] | undefined, asked?: string): string[] =>
  asked ? [asked] : (turns ?? []).map((t) => t.id).reverse();

export type ChangesScope = 'turn' | 'uncommitted' | 'branch';

/**
 * The scope a Changes pane opens with, like the official app: "last turn only" wins, then the scope
 * a caller asked for, then the user's last pick (Branch until they pick one).
 */
export function changesScope(
  panel: { scope?: string; turnId?: string },
  prefs: { changesScope?: ChangesScope; changesLastTurnOnly?: boolean } = {},
  inThread = true,
): ChangesScope {
  if (prefs.changesLastTurnOnly) return 'turn';
  if (panel.scope === 'turn' || panel.scope === 'uncommitted' || panel.scope === 'branch') return panel.scope;
  if (panel.turnId) return 'turn';
  const last = prefs.changesScope ?? 'branch';
  // a new chat has no turns: a remembered Last Turn falls back to Branch there
  return last === 'turn' && !inThread ? 'branch' : last;
}
