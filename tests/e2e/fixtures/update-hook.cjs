// Loaded into the app's main process before it starts (the `mainRequire` fixture option, Electron's -r) by update journeys.
// A dev build has no Squirrel: the updater acts as a signed macOS build that never reads a feed, `ready(version)` stands
// for Squirrel's update-downloaded, quitAndInstall quits the app (the test starts it again, as Squirrel would) and is
// recorded in update-hook.log in the profile ($MOPILOT_USER_DATA), and the stealth restart's ten minutes run on a clock the test moves (`advance`,
// `tick`). Everything else (the exit gate, the stealth conditions, the restart marker, the relaunch) is the app's own.
const fs = require('node:fs');
const path = require('node:path');

/**
 * Wraps the updater and the stealth restart as main loads them, and exposes the controls on `global.__updateHook`.
 * @param {{ Module: { _load: Function }, global?: any, env?: Record<string, string | undefined>, now?: number }} o
 */
function hookUpdates({ Module, global = globalThis, env = process.env, now = Date.now() }) {
  const hook = {
    now,
    updater: null,
    stealth: null,
    /** An update is downloaded and unpacked, as Squirrel's update-downloaded leaves it. */
    ready(version) {
      const u = hook.updater;
      const available = { version, notes: '' };
      u.stagedArtifact = { channel: u.channel, available, valid: true };
      u.set({ status: 'ready', available, error: null, checkedAt: Date.now() });
      return u.state;
    },
    advance(ms) {
      hook.now += ms;
      return hook.now;
    },
    /** One check of the stealth restart's conditions, as its 30-second timer runs it. */
    tick: () => hook.stealth.tick(),
    status: () => hook.updater?.state.status ?? null,
  };
  const record = (line) => env.MOPILOT_USER_DATA && fs.appendFileSync(path.join(env.MOPILOT_USER_DATA, 'update-hook.log'), `${line}\n`);

  const supported = (Updater, electron) =>
    class extends Updater {
      constructor(o) {
        super(o);
        Object.assign(this, { supported: true, manual: false, ready: Promise.resolve(true) });
        this.state = { ...this.state, status: 'idle' };
        hook.updater = this;
        // Squirrel installs and relaunches; here the app quits, and the test launches it again
        electron.autoUpdater.quitAndInstall = () => {
          record('quitAndInstall');
          electron.app.quit();
        };
      }
      // the feed is never read
      async check() {
        return this.state;
      }
    };
  const clocked = (create) => (o) => {
    hook.stealth = create({ ...o, now: () => hook.now, timers: { setInterval: () => ({ unref() {} }), clearInterval() {} } });
    return hook.stealth;
  };

  const done = new Set();
  const load = Module._load;
  Module._load = function (request, ...rest) {
    const out = load.call(this, request, ...rest);
    if (/(^|[\\/])updater\.cjs$/.test(request) && typeof out.Updater === 'function' && !done.has('updater')) {
      done.add('updater');
      out.Updater = supported(out.Updater, load.call(this, 'electron', ...rest));
    } else if (/(^|[\\/])stealthUpdate\.cjs$/.test(request) && typeof out.createStealthUpdate === 'function' && !done.has('stealth')) {
      done.add('stealth');
      out.createStealthUpdate = clocked(out.createStealthUpdate);
    }
    return out;
  };
  global.__updateHook = hook;
  return hook;
}

module.exports = { hookUpdates };
// the app's main process (Electron's -r): child processes that load this file get nothing
if (process.type === 'browser') hookUpdates({ Module: require('node:module') });
