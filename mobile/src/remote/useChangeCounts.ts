// The lines a chat has changed on the Mac (uncommitted), for the Changes chip; nothing until read, and nothing when the Mac cannot say.
import { useEffect, useState } from 'react';
import type { MobileRuntime } from '../contracts';
import { capabilities, type Owned } from './client';
import { listChanges } from './review';
import { useReviewEvents } from './useReviewEvents';

export type ChangeCounts = { files: number; added: number; removed: number };

/**
 * Read again when the turn ends or the Mac says the diff changed. `offered` is false where the app has no Changes screen; `enabled`
 * is false while a turn runs, so the Mac is not asked for every edit. Undefined until a read answers (and while none is made); null when
 * the read could not say.
 */
export function useChangeCounts(
  runtime: MobileRuntime,
  request: Owned,
  chatId: string,
  offered: boolean,
  enabled: boolean,
): ChangeCounts | null | undefined {
  const version = useReviewEvents(runtime, chatId, offered);
  const [read, setRead] = useState<{ chatId: string; counts: ChangeCounts | null } | null>(null);
  useEffect(() => {
    void version; // a changed diff is a new read
    // a turn that runs makes the last counts old: none show until the turn's end has been read
    if (!enabled) return setRead(null);
    // the Changes screen is not offered while the computer is away (a reconnect): that says nothing new about the changes, so the last read stays
    if (!offered) return;
    let active = true;
    void (async () => {
      let counts: ChangeCounts | null = null;
      try {
        const changes = await listChanges(request, chatId, 'uncommitted', await capabilities(request).catch(() => null));
        // the lines of a list the Mac cut short would be a wrong total: only the files are said
        const partial = changes.truncated || changes.omitted > 0;
        counts = {
          files: changes.files.length,
          added: partial ? 0 : changes.files.reduce((n, f) => n + f.added, 0),
          removed: partial ? 0 : changes.files.reduce((n, f) => n + f.removed, 0),
        };
      } catch {
        /* the chip is a shortcut: without counts it is not shown, and the Changes screen explains the failure */
      }
      if (active) setRead({ chatId, counts });
    })();
    return () => {
      active = false;
    };
  }, [request, chatId, offered, enabled, version]);
  return read?.chatId === chatId ? read.counts : undefined;
}
