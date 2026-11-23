// IPC for Computer History (#1363): starts it once the app is ready (no window needed), and serves Settings → Computer History and the composer's share picker: the state, turning it on and off, Pause / Resume, the allow lists, retention, the days and their memories, Delete day and Delete all. Every change goes to the windows as computerHistory:changed.
const { startComputerHistory, appComputerHistory } = require('../../computerHistory/service.cjs');
const { noteIgnored } = require('../../ignored.cjs');

const NOT_STARTED = { ok: false, error: 'Computer History has not started yet' };

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {Pick<import('../../main.cjs').IpcDeps, 'app' | 'broadcastAll' | 'live'>} deps
 * @param {{ electron?: { safeStorage?: any, powerMonitor?: any }, history?: typeof appComputerHistory, start?: typeof startComputerHistory }} [o]
 */
function register(ipcMain, { app, broadcastAll, live }, o = {}) {
  const history = o.history ?? appComputerHistory;
  const start = o.start ?? startComputerHistory;
  const electron = o.electron ?? require('electron');
  // started in a later task, so a failure to start (or an app without whenReady) never fails the registration
  Promise.resolve()
    .then(() => app.whenReady())
    .then(() =>
      start({
        userData: app.getPath('userData'),
        safeStorage: electron.safeStorage ?? null,
        powerMonitor: electron.powerMonitor ?? null,
        app,
        helper: () => live.computerUse?.helper ?? null,
        userDeny: () => live.computerUse?.grants?.deny?.() ?? [],
        broadcast: (state) => broadcastAll('computerHistory:changed', state),
      }),
    )
    .catch((error) => noteIgnored('start Computer History', error));

  /** A handler that answers NOT_STARTED until Computer History runs. */
  const on = (channel, fn) =>
    ipcMain.handle(channel, (_e, ...args) => {
      const h = history();
      return h ? fn(h, ...args) : NOT_STARTED;
    });
  on('computerHistory:state', (h) => ({ ok: true, state: h.recorder.state, exclusions: h.exclusions() }));
  on('computerHistory:setEnabled', (h, v) => h.act((r) => r.setEnabled(v === true)));
  on('computerHistory:pause', (h) => h.act((r) => r.pause()));
  on('computerHistory:resume', (h) => h.act((r) => r.resume()));
  on('computerHistory:allowApp', (h, app) => h.act((r) => r.allowApp(app)));
  on('computerHistory:removeApp', (h, id) => h.act((r) => r.removeApp(String(id))));
  on('computerHistory:allowSite', (h, site) => h.act((r) => r.allowSite(site)));
  on('computerHistory:removeSite', (h, site) => h.act((r) => r.removeSite(String(site))));
  on('computerHistory:setRetention', (h, days) => h.act((r) => r.setRetention(Number(days))));
  on('computerHistory:explainerSeen', (h) => h.act((r) => r.markExplainerSeen()));
  on('computerHistory:days', (h) => h.act(() => ({ days: h.days() })));
  on('computerHistory:memories', (h, q) => h.act(() => h.memories(q && typeof q === 'object' ? q : {})));
  on('computerHistory:deleteDay', (h, day) => h.act((r) => r.deleteDay(String(day))));
  on('computerHistory:deleteAll', (h) => h.act((r) => r.deleteAll()));
  on('computerHistory:candidates', async (h) => {
    // the apps running now, to pick from; the helper starts for it
    const helper = live.computerUse?.helper;
    if (!helper) return { ok: false, error: 'The computer-use helper is not available' };
    try {
      const listed = await helper.call('apps.list');
      return { ok: true, apps: h.candidates(listed?.apps) };
    } catch (error) {
      noteIgnored('list the running apps for Computer History', error);
      return { ok: false, error: 'Could not list the running apps' };
    }
  });
}

module.exports = { register };
