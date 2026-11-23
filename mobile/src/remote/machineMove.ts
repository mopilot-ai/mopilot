// The phone's client for moving a chat to another machine (Switch host): a machine's folders, and chat.move; a refusal keeps the Mac's own words.
import type { Owned } from './client';

export type Folder = { name: string; path: string; git: boolean };
export type FolderListing = { path: string; roots: string[]; entries: Folder[]; more: boolean };

const rec = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
const text = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** A machine's folders as the Mac lists them, read defensively: a row without a name or path is dropped; no path at all is no listing. */
export function parseFolders(raw: unknown): FolderListing {
  const r = rec(raw);
  const path = text(r?.path);
  if (!r || !path) throw new Error("Couldn't read that machine's folders. Try again.");
  const entries = (Array.isArray(r.entries) ? r.entries : []).flatMap((item) => {
    const e = rec(item);
    const name = text(e?.name);
    const at = text(e?.path);
    return name && at ? [{ name, path: at, git: e?.git === true }] : [];
  });
  const roots = (Array.isArray(r.roots) ? r.roots : []).flatMap((root) => text(root) ?? []);
  return { path, roots, entries, more: r.more === true };
}

/** The folders under `path` on a machine (its roots when no path is given). */
export async function readFolders(request: Owned, id: string, path?: string): Promise<FolderListing> {
  return parseFolders(await request('machines.folders', { id, ...(path ? { path } : {}) }));
}

/** Where a chat moves to: a folder on a machine, or (back on this Mac) one of the saved projects, which the Mac resolves itself. */
export type MoveTarget = { hostId: string; folder: string } | { hostId: 'local'; projectId: string };

/** Moves a chat to `target`; `carry` 'code' takes its uncommitted changes along, 'none' leaves them. */
export async function moveChat(request: Owned, move: { chatId: string; carry: 'code' | 'none' } & MoveTarget) {
  await request('chat.move', move);
}

export type SavedProject = { id: string; label: string; branch: string | null };

/**
 * The saved projects a chat can move back into on this Mac: none (null) from a Mac that does not take a project there
 * (`machine.hello` without `capabilities.moveToProject`), so the row stays a line that says to do it on the Mac.
 */
export async function readMoveProjects(request: Owned): Promise<SavedProject[] | null> {
  const caps = rec(rec(await request('machine.hello'))?.capabilities);
  if (caps?.moveToProject !== true) return null;
  const list = rec(await request('projects.list'))?.projects;
  return (Array.isArray(list) ? list : []).flatMap((item) => {
    const p = rec(item);
    const id = text(p?.id);
    return id ? [{ id, label: text(p?.name) ?? text(p?.label) ?? id, branch: text(p?.branch) }] : [];
  });
}
