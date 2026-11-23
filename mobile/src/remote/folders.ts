// The folders a Host offers for a new chat (machines.folders): where the list is, the roots it starts from, and the entries one level down.
import { bad, list, rec, str, type Owned } from './client';

export type FolderEntry = { name: string; path: string; git: boolean };
export type Folders = { path: string | null; roots: FolderEntry[]; entries: FolderEntry[]; more: boolean };

const entry = (raw: unknown): FolderEntry[] => {
  const r = rec(raw);
  const path = str(r?.path);
  return path ? [{ name: str(r?.name) ?? path, path, git: r?.git === true }] : [];
};

/** One folder's listing on machine `id` (its roots when `path` is null); a reply that is not one is refused. */
export async function loadFolders(request: Owned, id: string, path: string | null): Promise<Folders> {
  const r = rec(await request('machines.folders', path ? { id, path } : { id }));
  if (!r || !Array.isArray(r.entries)) return bad('the folders on that machine');
  return {
    path: str(r.path),
    // a root given as a plain path is named by its last part
    roots: list(r.roots).flatMap((x) =>
      typeof x === 'string' && x ? [{ name: x.split('/').filter(Boolean).at(-1) ?? x, path: x, git: false }] : entry(x),
    ),
    entries: r.entries.flatMap(entry),
    more: r.more === true,
  };
}

/** The folder chip's word: the folder's last part, or what to do when none is picked yet. */
export const folderChip = (folder: string | null) => (folder ? (folder.split('/').filter(Boolean).at(-1) ?? folder) : 'Choose a folder');
