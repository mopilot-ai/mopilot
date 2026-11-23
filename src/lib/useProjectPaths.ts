// Resolve navigation's complete folder snapshot; retired requests cannot publish paths or errors.
import { useCallback, useEffect, useState } from 'react';
import { isJsonRecord } from '../../shared/jsonRecord.mjs';
import { native } from './native';
import { noteIgnored } from './ignored';
import { isAbsolutePath } from './paths';
import { visiblePoll } from './visiblePoll';

const EMPTY_PATHS: Record<string, string> = {};

export function useProjectPaths(paths: string[], recheckMs?: number) {
  const key = JSON.stringify([...new Set(paths.filter(Boolean))].sort());
  const [snapshot, setSnapshot] = useState({ key: '', paths: EMPTY_PATHS, ready: false });
  useEffect(() => {
    let current = true;
    let pending = false;
    const requested: string[] = JSON.parse(key);
    const read = async () => {
      if (!current || pending) return;
      pending = true;
      try {
        const resolved = await native.projects.canonicalPaths(requested);
        if (!current) return;
        if (
          !isJsonRecord(resolved) ||
          requested.some((p) => !Object.hasOwn(resolved, p) || typeof resolved[p] !== 'string' || !isAbsolutePath(resolved[p]))
        )
          throw new TypeError('Invalid project folder identities');
        setSnapshot((last) =>
          last.key === key && last.ready && requested.every((p) => last.paths[p] === resolved[p])
            ? last
            : { key, paths: resolved, ready: true },
        );
      } catch (error) {
        if (!current) return;
        noteIgnored('resolve project folder identities', error);
        setSnapshot((last) => ({ key, paths: last.paths, ready: false }));
      } finally {
        pending = false;
      }
    };
    void read();
    const stop = recheckMs === undefined ? undefined : visiblePoll('project-paths', recheckMs, () => void read());
    return () => {
      current = false;
      stop?.();
    };
  }, [key, recheckMs]);
  // A changed folder set keeps the last answer until its own read lands: folders that did not change must not regroup
  // (a saved project would show a second row for its real path) while the new read is pending. Only `ready` waits for it.
  const resolved = snapshot.paths;
  const resolve = useCallback((p: string) => resolved[p] ?? p, [resolved]);
  return { resolve, ready: snapshot.key === key && snapshot.ready };
}
