// IPC for MoMo's home (momoHome:view, momoHome:intent, momoHome:changed): the windows read the whole view and send one intent at a time; each is answered by the home API main holds (electron/momo/homeSlot.cjs), refused while MoMo is not allowed, and answered "unavailable" while no home is composed. In a dev run (MOPILOT_MOMO_DEV=1, unpackaged) main serves the scripted fake home (shared/momoHomeFake.mjs) and momoHome:devScenario switches its scenario.
const { momoAllowed } = require('../../momo/access.cjs');
const { getHomeApi, setHomeApi, onHomeChanged } = require('../../momo/homeSlot.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/** The words of a refusal the window shows as is. */
const UNAVAILABLE = 'MoMo’s home isn’t available here yet.';

/** Whether this is a dev run: the unpackaged app with the dev switch. @param {{ isPackaged: boolean }} app */
const isDevRun = (app, env = process.env) => !app.isPackaged && env.MOPILOT_MOMO_DEV === '1';

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ broadcastAll: (channel: string, payload: unknown) => void }} deps
 * @param {{ allowed?: () => boolean, dev?: boolean, loadFake?: () => Promise<any>, scenario?: string }} [o] for tests
 */
function register(ipcMain, deps, o = {}) {
  const allowed = o.allowed ?? momoAllowed;
  const dev = o.dev ?? isDevRun(require('electron').app);
  /** @type {Promise<any> | null} */
  let fake = null;
  // the scripted home ships with the home lane's view code (#5490); where it is not there yet this import fails and the home stays unavailable
  const FAKE = '../../../shared/momoHomeFake.mjs';
  const loadFake = o.loadFake ?? (() => import(FAKE));
  /** Makes the scripted home on first use; a build without it (the file is not there) leaves the home unavailable. */
  const ensureFake = () => {
    if (!dev) return Promise.resolve(null);
    fake ??= loadFake().then(
      (m) => {
        const home = m.createFakeHome({ scenario: o.scenario ?? process.env.MOPILOT_MOMO_HOME_SCENARIO ?? 'running' });
        setHomeApi(home.api);
        return home;
      },
      (error) => {
        noteIgnored('load the scripted MoMo home', error);
        return null;
      },
    );
    return fake;
  };

  /** A whole view a dev journey sets (momoHome:devSetView): the scripted home only scripts the home and the chat, so the rest of a journey's screens is played from here. Dev runs only. @type {object | null} */
  let devView = null;

  /** @param {(api: NonNullable<ReturnType<typeof getHomeApi>>) => Promise<unknown>} run */
  const answer = async (run) => {
    if (!allowed()) return { ok: false, reason: 'not_allowed', cause: 'MoMo is not available.' };
    if (!getHomeApi()) await ensureFake();
    const api = getHomeApi();
    if (!api) return { ok: false, reason: 'unavailable', cause: UNAVAILABLE };
    try {
      return await run(api);
    } catch (error) {
      noteIgnored('answer a MoMo home call', error);
      return { ok: false, reason: 'error', cause: 'MoMo’s home didn’t answer.' };
    }
  };

  ipcMain.handle('momoHome:view', () =>
    devView
      ? Promise.resolve({ ok: true, view: devView })
      : answer(async (api) => ({ ok: true, .../** @type {object} */ (await api.view()) })),
  );
  ipcMain.handle('momoHome:intent', (_e, intent) => answer((api) => api.intent(intent)));
  ipcMain.handle('momoHome:dev', () => dev);
  ipcMain.handle('momoHome:devScenario', async (_e, name) => {
    const home = await ensureFake();
    if (!dev || !home || typeof name !== 'string') return false;
    home.scenario(name);
    return true;
  });
  // the scripted home's own refusal and release (dev runs only): the next intent of a kind is refused once with a cause and fix; a held move goes on
  ipcMain.handle('momoHome:devRefuse', async (_e, kind, cause, fix, fixLabel) => {
    const home = dev && allowed() && typeof kind === 'string' && typeof cause === 'string' ? await ensureFake() : null;
    if (typeof home?.refuse !== 'function') return false;
    home.refuse(kind, cause, fix, fixLabel);
    return true;
  });
  // what the scripted home says about a turn it is asked after (has, missing, unknown): a journey's way to play a lost connection
  ipcMain.handle('momoHome:devTurnAnswer', async (_e, turnId, answer) => {
    const home = dev && allowed() && typeof turnId === 'string' && typeof answer === 'string' ? await ensureFake() : null;
    if (typeof home?.turnAnswer !== 'function') return false;
    home.turnAnswer(turnId, answer);
    return true;
  });
  ipcMain.handle('momoHome:devRelease', async () => {
    const home = dev && allowed() ? await ensureFake() : null;
    if (typeof home?.release !== 'function') return false;
    home.release();
    return true;
  });
  ipcMain.handle('momoHome:devSetView', (_e, view) => {
    if (!dev || !allowed()) return false;
    devView = view && typeof view === 'object' ? view : null;
    deps.broadcastAll('momoHome:changed', { ev: 'momo.home.changed', view: devView });
    return true;
  });
  onHomeChanged((payload) => {
    if (allowed()) deps.broadcastAll('momoHome:changed', payload);
  });
}

module.exports = { register, isDevRun, UNAVAILABLE };
