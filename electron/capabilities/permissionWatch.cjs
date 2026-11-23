// The wait for a computer-use permission the user is turning on in System Settings (#2528): after Open Settings left a permission off, main reads it every couple of seconds, through a helper launched just for the read (platform/helperOffline.cjs: a running helper keeps its first answer, and System Settings asks the user to Quit & Reopen one that is running), and tells open Settings pages and permission cards (computer:changed) when it is on. Switching computer use off or quitting ends every wait.
const { GrantWatch } = require('../../shared/grantWatch.cjs');

/**
 * @param {{ read: () => Promise<any>, broadcast: (channel: string, payload: any) => void,
 *           onError: (what: string, error: unknown) => void,
 *           options?: { intervalMs?: number, timeoutMs?: number, sleep?: (ms: number) => Promise<unknown>, now?: () => number } }} o
 */
function createPermissionWatch({ read, broadcast, onError, options }) {
  const watch = new GrantWatch({
    isGranted: async (kind) => (await read())?.[kind] === true,
    onGranted: () => broadcast('computer:changed', { chatId: null }),
    onError,
    ...options,
  });
  return {
    /** Waits for `kind` to be turned on. */
    start(/** @type {string} */ kind) {
      watch.start(kind);
    },
    /** Ends every wait. */
    cancelAll() {
      for (const kind of watch.names()) watch.cancel(kind);
    },
  };
}

module.exports = { createPermissionWatch };
