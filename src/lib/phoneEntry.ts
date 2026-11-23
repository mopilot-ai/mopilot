// The entries that lead to Connect your phone: whether this account has Mobile Remote and how many phones it has paired, whether the sidebar banner was dismissed, and whether the one dialog is open.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ignoring } from './ignored';
import { native } from './native';
import type { RemoteSettingsState } from './native/remoteSettings';

const DISMISSED = 'phone-banner-dismissed';

let open = false;
const listeners = new Set<() => void>();
const setOpen = (next: boolean) => {
  if (next === open) return;
  open = next;
  for (const fn of [...listeners]) fn();
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export const openConnectPhone = () => setOpen(true);
export const closeConnectPhone = () => setOpen(false);
export const isConnectPhoneOpen = () => open;
export const useConnectPhoneOpen = () => useSyncExternalStore(subscribe, () => open);

/** Who sees an entry: the gate main answers with, so an uninvited account sees none and lifting the gate needs nothing else. */
export const entryOf = (state: RemoteSettingsState | null) =>
  state?.visible ? { available: true, paired: state.devices.filter((device) => !device.retired).length } : { available: false, paired: 0 };

/** Read when it mounts, when the window comes back and when the dialog opens or closes: an invite that changes meanwhile shows the next time someone looks. */
export function usePhoneEntry() {
  const [state, setState] = useState<RemoteSettingsState | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      void Promise.resolve()
        .then(() => native.remoteSettings.state())
        .then((next) => {
          if (live) setState(next);
        }, ignoring('read whether this account has Mobile Remote'));
    read();
    window.addEventListener('focus', read);
    const off = subscribe(read);
    return () => {
      live = false;
      window.removeEventListener('focus', read);
      off();
    };
  }, []);
  return entryOf(state);
}

export function phoneBannerDismissed() {
  try {
    return localStorage.getItem(DISMISSED) === '1';
  } catch {
    return false;
  }
}

export function dismissPhoneBanner() {
  try {
    localStorage.setItem(DISMISSED, '1');
  } catch (error) {
    // only a convenience: the banner comes back next time
    ignoring('remember the phone banner was dismissed')(error);
  }
}
