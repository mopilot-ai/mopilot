// The links that open a Settings page from anywhere in the app: lazy, so a store module can name a page without loading the pages; a failure is a toast.
import { toastFailure } from './core';

/** A function that opens one Settings section, on one tab of it when given. */
export const openSettings = (section: string, tab?: string) => () =>
  void import('./panes').then(
    ({ navigate }) => navigate({ name: 'settings', section, ...(tab ? { tab } : {}) }),
    toastFailure("Couldn't open Settings"),
  );

/** Settings › Connections › Control other devices: where a machine is added, signed in, turned back on or fixed. */
export const openMachines = openSettings('connections', 'other');
