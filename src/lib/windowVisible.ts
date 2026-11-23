// Whether this app window can be seen: not hidden or minimized, focused or not.

import { useSyncExternalStore } from 'react';

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

const documentVisible = () => document.visibilityState !== 'hidden';

/**
 * True while the window is visible. A window someone watches while typing in another app is visible but not
 * focused, and its streaming text still paces; only a hidden window skips the animation nobody sees.
 */
export function useWindowVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, documentVisible);
}
