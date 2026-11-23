// IPC for Settings → Computer access (#1364): this Mac's side (on/off, network, pairing, devices, active sessions, the
// access log, reset) and the computers this install uses (pair with one, forget one). Every value a window sends is
// checked here: ids are strings, switches booleans, scopes only the known ones.
const { SCOPES } = require('../../computerAccess/store.cjs');
const { userError } = require('../../../shared/userError.mjs');

/** A window's scopes: only the known ones, each a boolean. */
function scopesOf(v) {
  const o = v && typeof v === 'object' ? v : {};
  return Object.fromEntries(SCOPES.map((k) => [k, o[k] === true]));
}
const idOf = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null);

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ live: { computerAccess?: any }, broadcastAll: (channel: string, payload?: unknown) => void }} deps
 */
function register(ipcMain, { live, broadcastAll }) {
  const host = () => live.computerAccess?.host ?? null;
  const client = () => live.computerAccess?.client ?? null;
  /** A call that needs this Mac's side: it is up once main finished starting. */
  const withHost = (fn) => {
    const h = host();
    if (!h) throw new Error('Computer access is still starting');
    return fn(h);
  };
  ipcMain.handle('computerAccess:state', () => ({ host: host()?.state() ?? null, computers: client()?.hosts() ?? [] }));
  ipcMain.handle('computerAccess:setEnabled', (_e, on) => withHost((h) => h.setEnabled(on === true)));
  ipcMain.handle('computerAccess:setLan', (_e, on) => withHost((h) => h.setLan(on === true)));
  ipcMain.handle('computerAccess:startPairing', () => withHost((h) => h.startPairing()));
  ipcMain.handle('computerAccess:cancelPairing', () => withHost((h) => h.cancelPairing()));
  ipcMain.handle('computerAccess:answerPairing', (_e, allow, scopes) =>
    withHost((h) => {
      const device = h.answerPairing(allow === true, scopesOf(scopes));
      return device ? { id: device.id, name: device.name } : null;
    }),
  );
  ipcMain.handle('computerAccess:setDevice', (_e, id, patch) =>
    withHost((h) => {
      const p = patch && typeof patch === 'object' ? patch : {};
      h.setDevice(idOf(id), {
        ...(p.scopes ? { scopes: scopesOf(p.scopes) } : {}),
        ...(typeof p.hostOnlyApprovals === 'boolean' ? { hostOnlyApprovals: p.hostOnlyApprovals } : {}),
      });
      return true;
    }),
  );
  ipcMain.handle('computerAccess:revoke', (_e, id) => withHost((h) => h.revoke(idOf(id))));
  ipcMain.handle('computerAccess:stop', (_e, ownerId) => withHost((h) => h.owners.stop(idOf(ownerId))));
  ipcMain.handle('computerAccess:log', (_e, limit) =>
    withHost((h) => h.o.log.read(typeof limit === 'number' && limit > 0 ? Math.min(limit, 500) : 200)),
  );
  // a reset starts the shared store over: the computers this install used go too, with their connections and tools
  ipcMain.handle('computerAccess:reset', () =>
    withHost(async (h) => {
      await h.reset();
      client()?.close();
      client()?.sync();
    }),
  );
  // pairing with another computer: the code comes back now, the outcome later (the person there decides)
  ipcMain.handle('computerAccess:pair', async (_e, offer) => {
    const c = client();
    if (!c) throw new Error('Computer access is still starting');
    const { code, done } = await c.pair(String(offer ?? ''));
    done.then(
      (computer) => broadcastAll('computerAccess:paired', { ok: true, name: computer.name }),
      // "Couldn't connect.", not the other computer's address and port
      (error) => broadcastAll('computerAccess:paired', { ok: false, error: userError(error) }),
    );
    return { code };
  });
  ipcMain.handle('computerAccess:forget', (_e, id) => client()?.forget(idOf(id)) ?? false);
}

module.exports = { register, scopesOf };
