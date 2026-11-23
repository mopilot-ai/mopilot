// One chat's PR monitor state and settings writes, read once by the Changes card for its rows and its attach form.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NativeApi } from '../../lib/native';
import type { PrMonitorPatch, PrMonitorState } from '../../lib/native/prMonitor';
import { errorText } from '../../lib/ignored';
import { windowReady } from '../../lib/windowReady';

export type PrMonitorApi = NativeApi['prMonitor'];

/**
 * Reads the chat's snapshot, again whenever main reports a change for it. The newest read wins and nothing lands after
 * unmount, so a caller keyed by chat never shows (or writes) another chat's monitor. `api` must keep its identity
 * across renders (native.prMonitor does): a new object each render would subscribe and read again every render.
 */
export function usePrMonitor(chatId: string, api: PrMonitorApi) {
  const [state, setState] = useState<PrMonitorState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const life = useRef({ live: false, read: 0 });
  const read = useCallback(async () => {
    const owner = life.current;
    const seq = ++owner.read;
    try {
      // main refuses a window that hasn't told it it is ready ("Unknown app window"), shown until the monitor changes
      await windowReady();
      const value = await api.snapshot(chatId);
      if (owner.live && seq === owner.read) {
        setState(value);
        setError('');
      }
    } catch (e) {
      if (owner.live && seq === owner.read) setError(errorText(e));
    }
  }, [api, chatId]);
  useEffect(() => {
    const owner = { live: true, read: 0 };
    life.current = owner;
    void read();
    const off = api.onChanged((id) => {
      if (id === chatId) void read();
    });
    return () => {
      owner.live = false;
      off();
    };
  }, [chatId, api, read]);
  /** A patch writes settings; none re-reads GitHub. Resolves to the failure's text, or '' when it went through. */
  const mutate = async (patch?: PrMonitorPatch) => {
    const owner = life.current;
    setBusy(true);
    let failure = '';
    try {
      if (patch) await api.configure(chatId, patch);
      else await api.refresh(chatId);
      if (owner.live) await read();
    } catch (e) {
      failure = errorText(e);
      if (owner.live) setError(failure);
    } finally {
      if (owner.live) setBusy(false);
    }
    return failure;
  };
  return { state, error, busy, mutate };
}

/** The PR number from a canonical pull request URL (`…/pull/123`). */
export function prNumber(url: string) {
  return /\/pull\/(\d+)$/.exec(url)?.[1] ?? '';
}
