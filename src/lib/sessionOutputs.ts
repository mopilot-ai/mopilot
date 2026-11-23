// Session outputs come from completed normalized writes and persisted turn diffs, including shell-created files.
import { filePreviewKind } from '../../shared/filePreview.mjs';
import { pathKey } from './paths';
import { pathSpelling } from './pathSpelling';
import { parseUnifiedDiff } from './diff';
import { artifactCall, type ArtifactRef } from './designToolCall';
import type { TurnState } from '../../shared/model/store';

export type OutputFile = { path: string; turnId: string };
export type OutputWrite = { path: string; deleted: boolean };
const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Failed, incomplete and malformed operations provide no successful output evidence. */
export function writtenFiles(item: unknown): OutputWrite[] {
  const i = record(item);
  if (i?.type !== 'fileChange' || i.status !== 'completed' || !Array.isArray(i.changes)) return [];
  return i.changes.flatMap((value) => {
    const c = record(value);
    const kind = record(c?.kind);
    if (
      !c ||
      !kind ||
      typeof kind.type !== 'string' ||
      !['add', 'update', 'delete'].includes(kind.type) ||
      typeof c.path !== 'string' ||
      !c.path.trim()
    )
      return [];
    const moved = typeof kind.move_path === 'string' && kind.move_path.length > 0 ? kind.move_path : null;
    return [{ path: c.path, deleted: kind.type === 'delete' || !!moved }, ...(moved ? [{ path: moved, deleted: false }] : [])];
  });
}

/** The formats that can usefully reveal themselves after a write. Other outputs remain reachable in the inventory. */
export const visualOutput = (path: string) => ['image', 'video', 'pdf', 'html'].includes(filePreviewKind(path));

/** Latest surviving file per path, newest first. Loaded history rebuilds the inventory without opening a pane. */
export function sessionOutputs(turns: readonly TurnState[], cwd: string): OutputFile[] {
  const files = new Map<string, OutputFile>();
  for (const turn of turns) {
    if (turn.undone) continue;
    const writes =
      turn.diff !== undefined
        ? parseUnifiedDiff(turn.diff).flatMap((f) => [
            ...(f.oldPath && f.oldPath !== f.path && !f.isCopy ? [{ path: f.oldPath, deleted: true }] : []),
            { path: f.path, deleted: !!f.isDeleted },
          ])
        : turn.items.flatMap(writtenFiles);
    for (const write of writes) {
      const path = pathSpelling(write.path, cwd);
      const key = pathKey(path);
      files.delete(key);
      if (!write.deleted) files.set(key, { path, turnId: turn.id });
    }
  }
  return [...files.values()].reverse();
}

/** Published web artifacts share their existing typed identity and parser rather than guessing links from prose. */
export function sessionOutputPages(turns: readonly TurnState[]): ArtifactRef[] {
  const pages = new Map<string, ArtifactRef>();
  for (const turn of turns)
    for (const item of turn.items) {
      const page = artifactCall(item);
      if (!page) continue;
      const previous = pages.get(page.canonical);
      pages.delete(page.canonical);
      pages.set(page.canonical, { ...page, title: page.title ?? previous?.title ?? null });
    }
  return [...pages.values()].reverse();
}
