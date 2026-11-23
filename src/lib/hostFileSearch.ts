// The @ popup's file search in a chat on a machine (fs.search through its Host, #4106): asked after a short pause, the latest query wins, an answer is kept for its query while the popup is open (so a backspace is instant), and a machine that cannot answer says so. Never this Mac's results.
import { useRef, useState } from 'react';
import { useEffectOn } from './effects';
import { folderNotice } from './hostFolders';
import { ignoring } from './ignored';
import { native } from './native';

/** How long typing pauses before the machine is asked. */
export const SEARCH_DELAY_MS = 150;
/** The most files one answer lists. */
export const SEARCH_LIMIT = 12;

export type RemoteSearch = { state: 'searching' } | { state: 'ready'; files: string[] } | { state: 'unavailable'; notice: string };

/**
 * The files in `folder` on machine `machineId` whose names match `query`, best first; `searching` until the machine answers (the answer of an earlier query is not shown for this one). Without a machine or folder nothing is asked (`ready`, no files).
 */
export function useRemoteSearch(machineId: string | null, folder: string, query: string): RemoteSearch {
  const [answers, setAnswers] = useState<Record<string, RemoteSearch>>({});
  // the answers of this popup: it is one mount, so they go with it
  const kept = useRef(new Map<string, RemoteSearch>());
  const key = machineId && folder ? `${machineId}\n${folder}\n${query}` : null;
  useEffectOn([key], () => {
    if (!key || !machineId) return;
    if (kept.current.has(key)) return;
    // an earlier failure for this query is not shown while it is asked again
    setAnswers(({ [key]: _failed, ...rest }) => rest);
    let live = true;
    const timer = setTimeout(() => {
      const done = (a: RemoteSearch) => {
        // a failure is not kept: the next try asks again
        if (a.state === 'ready') kept.current.set(key, a);
        if (live) setAnswers((all) => ({ ...all, [key]: a }));
      };
      native.host.fsSearch(machineId, { path: folder, query, limit: SEARCH_LIMIT }).then(
        (r) => done(r.error ? { state: 'unavailable', notice: folderNotice(r.error) } : { state: 'ready', files: r.value.files }),
        (e) => (ignoring("search a machine's files")(e), done({ state: 'unavailable', notice: 'Could not search that machine.' })),
      );
    }, SEARCH_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  });
  if (!key) return { state: 'ready', files: [] };
  return kept.current.get(key) ?? answers[key] ?? { state: 'searching' };
}
