// Reconcile local sidebar folders on the shared visible poll, retaining decided answers through transient failures.
import { useEffect, useState } from 'react';
import { isJsonRecord } from '../../../shared/jsonRecord.mjs';
import { native } from '../../lib/native';
import { noteIgnored } from '../../lib/ignored';
import { visiblePoll } from '../../lib/visiblePoll';

export const FOLDER_RECHECK_MS = 60_000;
export const FOLDER_READ_TIMEOUT_MS = 10_000;

export function useFolderAvailability(paths: string[]) {
  const key = JSON.stringify([...new Set(paths.filter(Boolean))].sort());
  const [answers, setAnswers] = useState<Record<string, boolean | undefined>>({});
  useEffect(() => {
    const requested: string[] = JSON.parse(key);
    if (!requested.length) return;
    let current = true;
    let pending: object | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (!current || pending) return;
      const owner = {};
      pending = owner;
      // A silent IPC/filesystem read must not stop future revalidation. Its late result is retired too.
      timer = setTimeout(() => {
        pending = null;
      }, FOLDER_READ_TIMEOUT_MS);
      try {
        const result = await native.projects.folderAvailability(requested);
        if (!current || pending !== owner) return;
        if (
          !isJsonRecord(result) ||
          requested.some((p) => !Object.hasOwn(result, p) || (result[p] !== null && typeof result[p] !== 'boolean'))
        )
          throw new TypeError('Invalid folder availability');
        setAnswers((previous) => {
          const next = Object.fromEntries(requested.map((p) => [p, result[p] ?? previous[p]]));
          return Object.keys(previous).length === requested.length && requested.every((p) => previous[p] === next[p]) ? previous : next;
        });
      } catch (error) {
        if (current && pending === owner) noteIgnored('check sidebar folders', error);
      } finally {
        if (pending === owner) {
          clearTimeout(timer);
          pending = null;
        }
      }
    };
    void read();
    const stop = visiblePoll('sidebar-folders', FOLDER_RECHECK_MS, () => void read());
    return () => {
      current = false;
      clearTimeout(timer);
      stop();
    };
  }, [key]);
  return answers;
}
