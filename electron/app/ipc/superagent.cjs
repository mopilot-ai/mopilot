// IPC for Settings › Superagent (S1, watch only): the page reads the watcher's settings and observe log and changes the repo, the allowed list, rule modes, pause and marks.
// Behind the `superagent` flag: while it is off nothing opens, polls or shows; the flag is read again every few seconds so a flip opens or closes the store.
// Acts on nothing outside the Superagent database: nothing is posted, run or written to GitHub. MOPILOT_SUPERAGENT_FAKE_EVENTS names a JSON file of events a fake source emits (fake E2E only).
const fs = require('node:fs');
const path = require('node:path');
const { isEnabled } = require('../../platform/flags.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { createSuperagent } = require('../../superagent/index.cjs');
const { openStore, acknowledgeDamage } = require('../../superagent/store/index.cjs');
const { createWatch } = require('../../superagent/watch.cjs');
const { createRunner } = require('../../superagent/runner.cjs');
const { createFakeSource } = require('../../superagent/fakeSource.cjs');
const { createIntake } = require('../../superagent/intake/intake.cjs');
const { githubSourceFactory } = require('../superagentSource.cjs');
const { loadConfig } = require('../../superagent/gate/config.cjs');

const SYNC_MS = 5000;
const NOTIFY_MS = 250;

/**
 * @param {{ handle: (channel: string, fn: (event: unknown, ...args: any[]) => unknown) => void }} ipcMain
 * @param {{ app: { getPath: (name: 'userData') => string, isPackaged?: boolean }, broadcastAll: (channel: string, payload?: unknown) => void }} deps
 * @param {{ enabled?: () => boolean, fsOps?: typeof fs, now?: () => number, dir?: string,
 *           createSource?: any, setTimer?: (fn: () => void, ms: number) => any, openDb?: (file: string) => any, later?: (fn: () => void, ms: number) => unknown, github?: object,
 *           lifecycle?: { setTimer?: (fn: () => void, ms: number) => unknown, clearTimer?: (h: unknown) => void } }} [o] for tests
 */
function register(ipcMain, { app, broadcastAll }, o = {}) {
  const enabled = o.enabled ?? (() => isEnabled('superagent'));
  const fsOps = o.fsOps ?? fs;
  // a test hook: honored only in an unpackaged build, never in the app a person installed
  const fakeFile = app.isPackaged ? undefined : process.env.MOPILOT_SUPERAGENT_FAKE_EVENTS;
  const now = o.now ?? Date.now;
  const dir = o.dir ?? path.join(app.getPath('userData'), 'superagent');
  const file = path.join(dir, 'superagent.db');
  const createSource = fakeFile
    ? ({ repo, emit }) =>
        createFakeSource({
          repo,
          emit,
          readEvents: () => fsOps.readFileSync(fakeFile, 'utf8'),
          onError: (e) => noteIgnored('read the fake Superagent events', e),
        })
    : (o.createSource ??
      githubSourceFactory({
        getStore: () => sa.store,
        now,
        onStatus: (status) => setHealth(status),
        log: (message, error) => noteIgnored(message, error),
        deps: o.github,
      }));

  /** How the running source is doing (its last poll), for the page; cleared whenever a source starts or stops. */
  /** @type {{ state: string, reason?: string } | null} */
  let health = null;
  const setHealth = (status) => {
    const next = { state: status.state, ...(status.reason ? { reason: status.reason } : {}) };
    if (health && health.state === next.state && health.reason === next.reason) return;
    health = next;
    broadcastAll('superagent:changed');
  };
  const sa = createSuperagent({
    enabled,
    openStore: () => {
      fsOps.mkdirSync(dir, { recursive: true, mode: 0o700 });
      return openStore({ file, now, fsOps, openDb: o.openDb });
    },
    onError: (e) => noteIgnored('open the Superagent database', e),
    ...o.lifecycle,
  });
  // a burst of events (the first poll) tells the page once, not once per event
  let soon = false;
  const later = o.later ?? ((fn, ms) => setTimeout(fn, ms));
  const notifySoon = () => {
    if (soon) return;
    soon = true;
    later(() => {
      soon = false;
      broadcastAll('superagent:changed');
    }, NOTIFY_MS);
  };
  /** @type {{ store: any, intake: ReturnType<typeof createIntake> } | null} */
  let current = null;
  const receive = async (event) => {
    const store = sa.store;
    if (!store) return undefined;
    if (!current || current.store !== store) current = { store, intake: createIntake({ store, now }) };
    const result = await current.intake.receive(event);
    if (result.status === 'recorded' || result.status === 'paused') notifySoon();
    return result;
  };
  const runner = createRunner({
    getStore: () => sa.store,
    getConfig: loadConfig,
    // a new source starts with no health: the page shows what the one running now has reported
    createSource: (args) => {
      health = null;
      return createSource(args);
    },
    receive,
    onError: (e) => noteIgnored('record a Superagent event', e),
  });
  const watch = createWatch({
    getStore: () => sa.store,
    getError: () => sa.error,
    enabled,
    onChange: () => {
      runner.sync();
      broadcastAll('superagent:changed');
    },
    acknowledge: () => {
      acknowledgeDamage(file, fsOps);
      sa.clearError();
      sync();
    },
  });

  let announced = sa.store;
  /** Follows the flag (opens or closes the store) and then the settings (starts or stops the source). */
  function sync() {
    // a flip off closes the store after running handlers finish; the source is stopped first so nothing new arrives
    if (!enabled()) runner.stop();
    sa.sync();
    runner.sync();
    // the store can also open on the lifecycle's own retry: tell the page about any change since the last look
    if (announced !== sa.store) {
      announced = sa.store;
      broadcastAll('superagent:changed');
    }
  }

  const timer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref?.());
  const tick = () => {
    sync();
    timer(tick, SYNC_MS);
  };
  tick();

  // errors come back as values, so the window sees the message and its code (the bridge's call() rethrows them)
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        // the flag may have flipped since the last check: follow it before answering
        sync();
        return { value: await fn(...args) };
      } catch (err) {
        return { error: { message: String(/** @type {any} */ (err)?.message ?? err), code: /** @type {any} */ (err)?.code ?? null } };
      }
    });
  handle('superagent:state', () => {
    const source = runner.status();
    return { ...watch.state(), source: source.state === 'watching' && health ? { ...source, health } : source };
  });
  handle('superagent:setRepo', (repo) => watch.setRepo(repo));
  handle('superagent:setAllowed', (list) => watch.setAllowed(list));
  handle('superagent:setRule', (id, mode) => watch.setRuleMode(id, mode));
  handle('superagent:setPaused', (scope, paused) => watch.setPaused(scope, paused));
  handle('superagent:mark', (id, value) => watch.mark(id, value));
  handle('superagent:acknowledge', () => watch.acknowledgeDamage());
  return { sync, sa, runner };
}

module.exports = { register };
