// IPC for the connector rows in Settings › MoMo › Sources (#2999 C0, src/components/momo/ConnectorCard.tsx): every connector with its status (never a token), connect (the browser sign-in; the call answers when it is done), cancel a sign-in, disconnect (which deletes the account's tokens) and the access level; every change goes to the windows as momoConnectors:changed (no data in it). Every handler but disconnect refuses while MoMo is not allowed. Registered by the sources IPC (sources/ipc.cjs).
const { messageOf } = require('../../ignored.cjs');
const { SealedUnavailableError } = require('../../gateway/sealedFile.cjs');
const { ConnectorError } = require('./hub.cjs');
const { OAuthError } = require('../../gateway/oauth.cjs');

const CHANNELS = Object.freeze([
  'momoConnectors:list',
  'momoConnectors:connect',
  'momoConnectors:cancel',
  'momoConnectors:disconnect',
  'momoConnectors:setLevel',
]);
const NOT_ALLOWED = Object.freeze({ ok: false, reason: 'not_allowed', error: 'MoMo is not available' });

/**
 * Registers the handlers; returns a function that removes them again.
 * @param {Pick<import('electron').IpcMain, 'handle' | 'removeHandler'>} ipcMain
 * @param {{ hub: InstanceType<typeof import('./hub.cjs').ConnectorHub>, allowed: () => boolean, broadcast?: ((channel: string) => void) | null }} o
 */
function registerConnectorsIpc(ipcMain, { hub, allowed, broadcast = null }) {
  const changed = () => {
    if (allowed() === true) broadcast?.('momoConnectors:changed');
  };
  hub.on('changed', changed);
  /** A handler answering NOT_ALLOWED while MoMo is not allowed, and a failure as `{ ok: false, error, reason? }`. */
  const on = (/** @type {string} */ channel, /** @type {(...args: any[]) => any} */ fn) =>
    ipcMain.handle(channel, async (_e, ...args) => {
      if (allowed() !== true) return NOT_ALLOWED;
      try {
        return { ok: true, ...(await fn(...args)) };
      } catch (error) {
        const reason = error instanceof ConnectorError || error instanceof OAuthError ? error.code : undefined;
        return { ok: false, error: messageOf(error), ...(reason && { reason }) };
      }
    });
  // no OS key: nothing can be kept, so nothing is listed as connected and nothing connects
  on('momoConnectors:list', () => {
    try {
      return { connectors: hub.list(), available: true };
    } catch (error) {
      if (!(error instanceof SealedUnavailableError)) throw error;
      return { connectors: [], available: false };
    }
  });
  on('momoConnectors:connect', async (id) => ({ connector: await hub.connect(id) }));
  on('momoConnectors:cancel', (id) => ({ cancelled: hub.cancel(id) }));
  // an account whose invite was revoked can still remove its tokens
  on('momoConnectors:disconnect', async (id) => (await hub.disconnect(id), {}));
  on('momoConnectors:setLevel', async (id, level) => (await hub.setLevel(id, level), {}));
  return () => {
    hub.off('changed', changed);
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}

module.exports = { registerConnectorsIpc, CHANNELS, NOT_ALLOWED };
