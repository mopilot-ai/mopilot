// The end of Connect your phone: the dialog closes by itself, a toast says who connected, and the first time this Mac is also set to stay reachable.
import { useEffect } from 'react';
import { native } from '../../../lib/native';
import { toast, toastFailure } from '../../../store/core';

const REACHABLE = (on: boolean) => ({ keepRunning: on, loginItem: on, preventSleep: on });

/** Closes the dialog once the phone is connected. After the first pairing this Mac is kept reachable, and the toast says where to change that. */
export function Connected({ name, close }: { name: string; close: () => void }) {
  useEffect(() => {
    let first = false;
    void (async () => {
      const now = await native.alwaysOn.get();
      if (now && !now.prefs.offered) {
        await native.alwaysOn.set(REACHABLE(true));
        first = true;
      }
    })()
      .catch(toastFailure("Couldn't keep this Mac reachable"))
      .finally(() => {
        toast(first ? `Connected: ${name}. This Mac stays reachable; change it in Settings › Connections.` : `Connected: ${name}`);
        close();
      });
  }, [name, close]);
  return null;
}
