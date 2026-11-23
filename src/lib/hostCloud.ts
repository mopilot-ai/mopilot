// Cloud machines in the window (host.cloud): whether the feature is on, and each cloud machine's line (shared/cloud/cloudLine.mjs) read from main, read again when main says a machine's state changed.
import { useEffect, useState } from 'react';
import { isEnabled } from './flags';
import { native } from './native';
import type { CloudLine } from './native/host';
import { noteIgnored } from './ignored';

/** Whether cloud machines are on in this build and account (`host.cloud`, off by default). */
export const cloudOn = (): boolean => {
  try {
    return isEnabled('host.cloud');
  } catch {
    // no native bridge in this window (a bare preview): none of it is shown
    return false;
  }
};

/** The line of each cloud machine in `ids` (null: none of the cloud states applies, so the ordinary line shows). Nothing is asked while the flag is off. */
export function useCloudLines(ids: readonly string[]): ReadonlyMap<string, CloudLine> {
  const [lines, setLines] = useState<ReadonlyMap<string, CloudLine>>(new Map());
  const key = ids.join('\n');
  useEffect(() => {
    if (!cloudOn() || !key) return setLines(new Map());
    const list = key.split('\n');
    let live = true;
    const lineOf = async (id: string): Promise<readonly [string, CloudLine]> => {
      try {
        return [id, await native.host.cloudLine(id)];
      } catch (error) {
        noteIgnored('read a cloud machine’s line', error);
        return [id, null];
      }
    };
    const read = () =>
      void Promise.all(list.map(lineOf)).then((rows) => {
        if (live) setLines(new Map(rows));
      });
    read();
    const off = native.host.onCloud((e) => {
      if (e.kind !== 'launch' && e.kind !== 'step') read();
    });
    return () => {
      live = false;
      off();
    };
  }, [key]);
  return lines;
}
