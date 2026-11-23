// A Host chat's repository identity and changes, read through its machine on open, turn changes, focus and manual refresh.
import { useCallback, useRef, useState } from 'react';
import { useEffectOn, useWindowListener } from './effects';
import { diffTotals } from './diff';
import { ignoring } from './ignored';
import { folderNotice } from './hostFolders';
import { native } from './native';
import type { HostGitStatus } from './native/host';
import type { ChatMachine } from './chatMachine';

export type RemoteRepo =
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'unavailable'; notice: string }
  | {
      state: 'ready';
      branch: string | null;
      remote: string | null;
      files: number;
      added: number;
      removed: number;
      untracked: number;
      truncated: boolean;
    };

/** The totals the summary shows for a status the Host sent: files, and their lines, an untracked file's too when the Host counted them (`untracked` is how many are left uncounted). */
export function repoOf(s: Extract<HostGitStatus, { isRepo: true }>): Extract<RemoteRepo, { state: 'ready' }> {
  return {
    state: 'ready',
    branch: s.branch,
    remote: s.remote,
    files: s.files.length,
    ...diffTotals(s.files),
    untracked: s.files.filter((f) => f.untracked && !f.counted).length,
    truncated: s.truncated || s.unreadable,
  };
}

/**
 * `folder`'s repository on `machine`; null while there is no machine or the machine is offline. `turn` changes when the chat's last turn does (the files it changed are on the machine).
 */
export function useRemoteRepo(machine: ChatMachine | null, folder: string, turn: unknown) {
  const id = machine && !machine.away && folder ? machine.id : null;
  const key = id ? JSON.stringify([id, folder]) : null;
  const [shownKey, setShownKey] = useState(key);
  const [read, setRead] = useState<{ key: string; repo: RemoteRepo } | null>(null);
  if (shownKey !== key) {
    setShownKey(key);
    setRead(null);
  }
  const request = useRef(0);
  const refresh = useCallback(() => {
    if (!id || !key) return;
    const mine = ++request.current;
    native.host.gitStatus(id, { path: folder }).then(
      (r) => {
        if (mine !== request.current) return;
        if (r.error) return setRead({ key, repo: { state: 'unavailable', notice: folderNotice(r.error) } });
        setRead({ key, repo: r.value.isRepo ? repoOf(r.value) : { state: 'none' } });
      },
      (e) => {
        ignoring("read a machine's repository")(e);
        if (mine === request.current) setRead({ key, repo: { state: 'unavailable', notice: 'Could not read the folder on the machine.' } });
      },
    );
  }, [id, key, folder]);
  useEffectOn([refresh, turn], () => {
    refresh();
    return () => {
      request.current++;
    };
  });
  useWindowListener('focus', refresh);
  const repo: RemoteRepo | null = !key ? null : read?.key === key ? read.repo : { state: 'loading' };
  return { repo, refresh };
}
