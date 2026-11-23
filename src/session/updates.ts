// Renderer side of auto-update: keeps the main-process updater in sync with prefs and exposes its state.
import { useEffect, useState } from 'react';
import { native, type UpdateState } from '../lib/native';
import { ignoring } from '../lib/ignored';
import { createLatestLoader } from '../lib/latestLoader';
import { useStore } from '../store/core';

const INITIAL: UpdateState = { status: 'idle', version: '', available: null, error: null, checkedAt: null };

export function useUpdateState() {
  const [st, setSt] = useState<UpdateState>(INITIAL);
  useEffect(() => {
    const loader = createLatestLoader(() => native.updates.state(), setSt, ignoring('read the update state'));
    const off = native.updates.onState(loader.push);
    void loader.load();
    return () => {
      loader.stop();
      off();
    };
  }, []);
  return st;
}

/** Push the auto-update prefs to the main process whenever they change. */
export function useUpdatePrefsSync() {
  const auto = useStore((s) => s.prefs.autoUpdate);
  const channel = useStore((s) => s.prefs.updateChannel);
  useEffect(() => {
    // the main process only honours dogfood for an internal account
    native.updates
      .configure({ auto: auto !== false, channel: channel === 'beta' || channel === 'dogfood' ? channel : 'stable' })
      // main keeps its last schedule; the next change to the prefs sends them again
      .catch(ignoring('apply the update preferences'));
  }, [auto, channel]);
}
