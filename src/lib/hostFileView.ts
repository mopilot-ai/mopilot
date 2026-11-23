// A machine's folder entries and file text, read through its Host (fs.tree, fs.read; #4104): one read per request, again when `reload` changes, never on a timer. The answer is the one for the machine and path asked; a refusal says why in words.
import { useState } from 'react';
import { useEffectOn } from './effects';
import { folderNotice } from './hostFolders';
import { ignoring } from './ignored';
import { native } from './native';
import type { HostDiff, HostFileView, HostReply, HostTree } from './native/host';

export type Loaded<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'unavailable'; notice: string };

/** One request made again whenever `key` or `reload` changes; the answer of an earlier request never replaces a later one's. */
function useHostReply<T>(key: string, ask: () => Promise<HostReply<T>>, reload: number | string): Loaded<T> {
  const [read, setRead] = useState<{ key: string; loaded: Loaded<T> } | null>(null);
  useEffectOn([key, reload], () => {
    let live = true;
    const done = (loaded: Loaded<T>) => live && setRead({ key, loaded });
    ask().then(
      (r) => done(r.error ? { state: 'unavailable', notice: folderNotice(r.error) } : { state: 'ready', value: r.value }),
      (e) => (ignoring("read a machine's files")(e), done({ state: 'unavailable', notice: 'Could not read that on the machine.' })),
    );
    return () => {
      live = false;
    };
  });
  // the last answer for this path stays while a reload asks again
  return read && read.key === key ? read.loaded : { state: 'loading' };
}

/** The patch of what changed in `path` on the machine, against HEAD or the base branch. */
export const useRemoteDiff = (machineId: string, path: string, scope: 'uncommitted' | 'branch', reload: number | string = 0) =>
  useHostReply<HostDiff>(`diff\n${scope}\n${machineId}\n${path}`, () => native.host.gitDiff(machineId, { path, scope }), reload);

/** The entries of `path` on the machine. */
export const useRemoteTree = (machineId: string, path: string, reload = 0) =>
  useHostReply<HostTree>(`tree\n${machineId}\n${path}`, () => native.host.fsTree(machineId, { path }), reload);

/** The start of the file `path` on the machine. */
export const useRemoteFile = (machineId: string, path: string, reload: number | string = 0) =>
  useHostReply<HostFileView>(`file\n${machineId}\n${path}`, () => native.host.fsRead(machineId, { path }), reload);
