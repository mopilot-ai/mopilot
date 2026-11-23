// MoMo's settings in the renderer (#2139): read from prefs.momo with their defaults (shared/momoPrefs.mjs), and changed one key at a time through main, which merges the change into what is saved (electron/app/ipc/momoPrefs.cjs); the saved change reaches every window as a prefs change.
import { useMemo } from 'react';
import { readMomoPrefs, type MomoPrefKey, type MomoPrefValues, type MomoPrefs } from '../../shared/momoPrefs.mjs';
import { useStore, toast } from '../store/core';
import { errorText } from '../lib/ignored';
import { native } from '../lib/native';

/** MoMo's settings as saved now. */
export function useMomoPrefs(): MomoPrefs {
  const momo = useStore((s) => (s.prefs as { momo?: unknown }).momo);
  return useMemo(() => readMomoPrefs(momo), [momo]);
}

/**
 * Saves one setting; resolves once it is saved and this window has it (false, and the user is told, when it was not).
 * Never rejects, so a control waiting on it always ends its pending state.
 */
export function saveMomoPref<K extends MomoPrefKey>(key: K, value: MomoPrefValues[K]): Promise<boolean> {
  return native.momoPrefs.set(key, value).then(
    () => true,
    // main's message says what failed in the user's words
    (error) => (toast(errorText(error), 'error'), false),
  );
}
