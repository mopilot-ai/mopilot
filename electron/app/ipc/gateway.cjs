// IPC for the MCP gateway (#2999 C2, electron/gateway; its Settings UI is C5): the managed servers and their states, adding and removing one, saving or forgetting its credential, and restarting it. A credential goes from the window to the vault and never comes back: the list says only whether one is saved. Every change reaches the windows as gateway:changed (electron/app/gatewayWiring.cjs), with no data in it.
const { messageOf } = require('../../ignored.cjs');
const { lockedOf } = require('../../gateway/upstream.cjs');

const KEY_MAX = 8192;
const NOT_OPEN = Object.freeze({ ok: false, error: 'The gateway has not started' });

/** A server key from a window, or null. */
const keyOf = (/** @type {unknown} */ v) => (typeof v === 'string' && v.length > 0 && v.length <= KEY_MAX ? v : null);

/**
 * @param {Pick<import('electron').IpcMain, 'handle'>} ipcMain
 * @param {{ live: { gateway?: InstanceType<typeof import('../../gateway/service.cjs').Gateway> | null }, shell: Pick<import('electron').Shell, 'openExternal'> }} deps
 */
function register(ipcMain, { live, shell }) {
  const on = (/** @type {string} */ channel, /** @type {(gateway: any, ...args: any[]) => any} */ fn) =>
    ipcMain.handle(channel, async (_e, ...args) => {
      const gateway = live.gateway;
      if (!gateway) return NOT_OPEN;
      try {
        return { ok: true, ...(await fn(gateway, ...args)) };
      } catch (error) {
        // the sealed store's own words speak of MoMo: the gateway's say which data can't be opened
        return { ok: false, error: lockedOf(error) ?? messageOf(error) };
      }
    });
  const keyed = (/** @type {string} */ channel, /** @type {(gateway: any, key: string, ...args: any[]) => any} */ fn) =>
    on(channel, (gateway, key, ...args) => {
      const k = keyOf(key);
      if (!k) throw new Error('Not a managed server');
      return fn(gateway, k, ...args);
    });
  on('gateway:list', (gateway) => gateway.view());
  on('gateway:add', async (gateway, spec) => ({ key: (await gateway.add(spec)).key }));
  keyed('gateway:remove', async (gateway, key) => (await gateway.remove(key), {}));
  keyed('gateway:connect', async (gateway, key, credential) => (await gateway.connect(key, credential), {}));
  keyed('gateway:disconnect', async (gateway, key) => (await gateway.disconnect(key), {}));
  keyed('gateway:restart', async (gateway, key) => (await gateway.restart(key), {}));
  // OAuth: the sign-in page opens in the user's browser; the call ends when the sign-in does (or is cancelled)
  keyed('gateway:signIn', async (gateway, key) => (await gateway.signIn(key, (/** @type {string} */ url) => shell.openExternal(url)), {}));
  keyed('gateway:cancelSignIn', async (gateway, key) => (gateway.cancelSignIn(key), {}));
  // the allow / ask / block rules (C3): the list, and adding, removing or resetting them
  on('gateway:rules', (gateway) => gateway.rulesView());
  on('gateway:addRule', async (gateway, rule) => ({ rule: await gateway.addRule(rule) }));
  on('gateway:removeRule', async (gateway, id) => {
    if (typeof id !== 'string' || !id || id.length > 64) throw new Error('Not a rule');
    await gateway.removeRule(id);
    return {};
  });
  on('gateway:resetRules', async (gateway) => (await gateway.resetRules(), {}));
}

module.exports = { register, keyOf };
