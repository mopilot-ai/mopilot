// Keeps the Mac reachable for Mobile Remote with no window open: a menu-bar item instead of a Dock icon, an opt-in login item and an opt-in sleep blocker. All of it is gated by remote.enabled and the user's own switches; nothing runs for a user who did not opt in.
const path = require('node:path');
const { readJson, writeAtomic } = require('../platform/fsutil.cjs');
const { phoneDevices } = require('../remote/phoneDevices.cjs');
const { phoneCounts } = require('../../shared/phoneConnections.mjs');
const { phoneTrayItems } = require('./phoneTray.cjs');

/** How often the paired-phone state is read while a switch is on (the relay has no push for it to this layer). */
const POLL_MS = 10_000;
const FILE = 'always-on.json';
/** The user's three switches; every one is off until they turn it on. `offered`: the first pairing has put them on once, so a later one leaves what the person chose. */
const DEFAULTS = Object.freeze({ keepRunning: false, loginItem: false, preventSleep: false, offered: false });

/**
 * @typedef {{ [K in keyof typeof DEFAULTS]: boolean }} AlwaysOnPrefs
 * @typedef {{ prefs: AlwaysOnPrefs, remoteOn: boolean, active: boolean, paired: number, connected: boolean, loginItemSupported: boolean }} AlwaysOnState
 */

/**
 * @param {object} o
 * @param {Electron.App} o.app
 * @param {Pick<typeof Electron.BrowserWindow, 'getAllWindows'>} o.BrowserWindow
 * @param {{ start(type: 'prevent-app-suspension'): number, stop(id: number): void, isStarted(id: number): boolean } | null} o.powerSaveBlocker
 * @param {{ isOnBatteryPower(): boolean, on(event: string, cb: () => void): unknown, removeListener(event: string, cb: () => void): unknown } | null} [o.powerMonitor] what says the Mac is plugged in
 * @param {string} o.userData
 * @param {{ remote?: ReturnType<typeof import('../remote/runtime.cjs').openRemote> | null }} o.live read late: the runtime is made after this
 * @param {(what: string, error: unknown) => void} o.ignored reports a failure that is swallowed (main's noteIgnored)
 * @param {() => void} o.refreshTray redraws the menu-bar item (electron/app/menu.cjs), which asks back for `active` and `trayItems`
 * @param {() => boolean} o.flagOn remote.enabled
 * @param {(state: AlwaysOnState) => void} o.onChange every window reads the state from here
 * @param {string} [o.platform]
 */
function createAlwaysOn({
  app,
  BrowserWindow,
  powerSaveBlocker,
  powerMonitor = null,
  userData,
  live,
  ignored,
  refreshTray,
  flagOn,
  onChange,
  platform = process.platform,
}) {
  const file = path.join(userData, FILE);
  const loginItemSupported = platform === 'darwin' || platform === 'win32';
  /** @type {AlwaysOnPrefs} */
  let prefs = readPrefs();
  /** @type {number | null} */
  let blockerId = null;
  let dockHidden = false;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {(() => void) | null} */
  let unsubscribe = null;
  /** @type {object | null} the channel the pair listener is on */
  let listening = null;

  function readPrefs() {
    const saved = readJson(file, {});
    const read = { ...DEFAULTS, ...Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, saved?.[k] === true])) };
    // a file from before `offered`: the person has already made these choices
    return Object.keys(Object(saved)).length ? { ...read, offered: true } : read;
  }

  const channel = () => (live.remote?.running ? live.remote.channel : null);
  const pairs = () => channel()?.pairs() ?? [];
  const phones = () => phoneDevices(live.remote);
  const active = () => !!live.remote?.running && prefs.keepRunning;
  const windowsOpen = () => BrowserWindow.getAllWindows().some((w) => w.isVisible() || w.isMinimized());

  /** @returns {AlwaysOnState} */
  function state() {
    const { paired, connected } = phoneCounts(phones());
    return {
      prefs: { ...prefs },
      remoteOn: !!live.remote?.running,
      active: active(),
      paired,
      connected: connected > 0,
      loginItemSupported,
    };
  }

  function applyLoginItem(/** @type {boolean} */ owned) {
    if (!loginItemSupported) return;
    const want = active() && prefs.loginItem;
    // only an item this switch set is ever cleared: a login item the user made themselves stays
    if (!want && !owned) return;
    if (app.getLoginItemSettings().openAtLogin !== want) app.setLoginItemSettings({ openAtLogin: want });
  }

  function applyBlocker() {
    // reachable means a phone can come back to it, so this does not wait for one to be connected; on battery the Mac sleeps as usual
    const want = active() && prefs.preventSleep && pairs().length > 0 && !powerMonitor?.isOnBatteryPower();
    if (want && blockerId === null) blockerId = powerSaveBlocker?.start('prevent-app-suspension') ?? null;
    else if (!want && blockerId !== null) {
      if (powerSaveBlocker?.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
      blockerId = null;
    }
  }

  /** The Dock icon goes with the last window while the menu-bar item carries the app, and comes back with the next one. */
  function applyDock() {
    const hide = active() && !windowsOpen();
    if (hide === dockHidden || !app.dock) return;
    dockHidden = hide;
    if (hide) app.dock.hide();
    else void Promise.resolve(app.dock.show()).catch((error) => ignored('show the Dock icon', error));
  }

  function applyTimer() {
    const wanted = prefs.keepRunning || prefs.loginItem || prefs.preventSleep;
    if (wanted && !timer) {
      timer = setInterval(tick, POLL_MS);
      timer.unref?.();
    } else if (!wanted && timer) {
      clearInterval(timer);
      timer = null;
    }
    // a pair added or removed is seen at once, not at the next poll: the last pair going releases the blocker now
    const want = wanted ? channel() : null;
    if (want === listening) return;
    unsubscribe?.();
    unsubscribe = want ? want.onPairsChanged(tick) : null;
    listening = want;
  }

  let last = '';
  const tick = () => apply();
  // plugged in or out: the sleep blocker follows at once
  powerMonitor?.on('on-ac', tick);
  powerMonitor?.on('on-battery', tick);
  /** @param {boolean} [owned] whether the OS login item may be cleared (it is only ever cleared when this switch set it) */
  function apply(owned = prefs.loginItem) {
    try {
      applyTimer();
      applyLoginItem(owned);
      applyBlocker();
      applyDock();
      const s = state();
      // Counts alone miss a renamed phone, a different connected phone, or a paused session.
      const key = JSON.stringify([s, !!live.remote?.devices?.locked, phones().map(({ id, name, connection }) => [id, name, connection])]);
      if (key === last) return;
      last = key;
      refreshTray();
      onChange(s);
    } catch (error) {
      ignored('apply the always-on settings', error);
    }
  }

  /** Last window gone, shown, hidden or minimized: the Dock icon follows. */
  function watchWindows() {
    const follow = () => applyDock();
    app.on('browser-window-created', (_e, w) => {
      w.on('show', follow).on('hide', follow).on('minimize', follow).on('restore', follow).on('closed', follow);
      follow();
    });
  }

  return {
    watchWindows,
    /** @returns {AlwaysOnState} */
    get: state,
    /** Whether the app stays up (and in the menu bar) with every window closed. */
    get active() {
      return active();
    },
    /** Re-reads everything it follows (the remote switch, the pairs); startup and the Settings switch call it. */
    sync: tick,
    /**
     * @param {Partial<AlwaysOnPrefs>} patch unknown keys and non-booleans are ignored
     * @returns {AlwaysOnState}
     */
    set(patch) {
      const next = { ...prefs };
      for (const k of Object.keys(DEFAULTS)) if (typeof patch?.[k] === 'boolean') next[k] = patch[k];
      // a switch the person moved is a choice the first pairing must not override
      if (['keepRunning', 'loginItem', 'preventSleep'].some((k) => typeof patch?.[k] === 'boolean')) next.offered = true;
      const before = prefs;
      prefs = next;
      try {
        writeAtomic(file, JSON.stringify(next));
      } catch (error) {
        // the switch does not move if it can't be kept
        prefs = before;
        throw error;
      }
      apply(before.loginItem || next.loginItem);
      return state();
    },
    /** Launched by the login item with the switch on: no window opens, the menu-bar item is the app. */
    startsQuietly() {
      return flagOn() && loginItemSupported && prefs.keepRunning && prefs.loginItem && !!app.getLoginItemSettings().wasOpenedAtLogin;
    },
    /** A quit is coming: the Dock icon shows so the exit gate's question is on screen. */
    surface() {
      if (dockHidden && app.dock) {
        dockHidden = false;
        void Promise.resolve(app.dock.show()).catch((error) => ignored('show the Dock icon', error));
      }
    },
    /** @returns {Electron.MenuItemConstructorOptions[]} compact, inspectable phone status */
    /** @param {() => void} [manage] opens the phone settings, including when a phone is already paired */
    trayItems(manage) {
      return phoneTrayItems(phones(), manage, !!live.remote?.devices?.locked);
    },
    /** Quit: the blocker and the poll go; the login item stays as the user set it. */
    close() {
      powerMonitor?.removeListener('on-ac', tick);
      powerMonitor?.removeListener('on-battery', tick);
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
      if (blockerId !== null && powerSaveBlocker?.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
      blockerId = null;
    },
  };
}

module.exports = { createAlwaysOn, DEFAULTS, POLL_MS, FILE };
