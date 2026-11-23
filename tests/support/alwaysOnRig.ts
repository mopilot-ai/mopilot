// Fakes for Mobile Remote's always-on controller: Electron's app, windows and power-save blocker, and a remote runtime whose pairs and presence a test moves.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAlwaysOn } = require('../../electron/app/alwaysOn.cjs');

export function rig(opts: { platform?: string; saved?: object; dock?: boolean; blocker?: boolean; flag?: boolean } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'always-on-'));
  if (opts.saved) fs.writeFileSync(path.join(userData, 'always-on.json'), JSON.stringify(opts.saved));
  const log: string[] = [];
  const app: any = Object.assign(new EventEmitter(), {
    login: { openAtLogin: false, wasOpenedAtLogin: false },
    getLoginItemSettings() {
      return app.login;
    },
    setLoginItemSettings(s: { openAtLogin: boolean }) {
      log.push(`login:${s.openAtLogin}`);
      app.login.openAtLogin = s.openAtLogin;
    },
    dock:
      opts.dock === false
        ? undefined
        : {
            hide: () => void log.push('dock:hide'),
            show: () => (log.push('dock:show'), app.dockShow()),
          },
    dockShow: () => Promise.resolve(),
  });
  const windows: any[] = [];
  const BrowserWindow = { getAllWindows: () => windows.filter((w) => !w.gone) };
  const makeWindow = (visible = true) => {
    const w: any = Object.assign(new EventEmitter(), {
      visible,
      minimized: false,
      gone: false,
      isVisible: () => w.visible,
      isMinimized: () => w.minimized,
    });
    windows.push(w);
    app.emit('browser-window-created', {}, w);
    return w;
  };
  const started = new Set<number>();
  let next = 1;
  const powerSaveBlocker =
    opts.blocker === false
      ? null
      : {
          start: (type: string) => (log.push(`block:${type}`), started.add(next), next++),
          stop: (id: number) => (log.push('unblock'), started.delete(id)),
          isStarted: (id: number) => started.has(id),
        };
  const power: any = Object.assign(new EventEmitter(), { battery: false, isOnBatteryPower: () => power.battery });
  const powerMonitor = opts.blocker === false ? null : power;
  const pairListeners = new Set<() => void>();
  const presence = new Map<string, string>();
  const channel = {
    pairs: () => [...presence.keys()],
    statsOf: () => null,
    closedReason: () => null,
    presence: (p: string) => presence.get(p) ?? 'gone',
    onPairsChanged: (fn: () => void) => (pairListeners.add(fn), () => void pairListeners.delete(fn)),
  };
  const live: any = { remote: { running: false, channel: null as any } };
  const remote = {
    start() {
      live.remote.running = true;
      live.remote.channel = channel;
      live.remote.devices = {
        list: () => [...presence.keys()].map((id) => ({ id, pairId: id, name: id })),
        isRetired: () => false,
      };
      live.remote.presence = {
        isOnline: (id: string) => presence.get(id) === 'online',
        isAbsent: (id: string) => presence.get(id) !== 'online',
      };
    },
    stop() {
      live.remote.running = false;
      live.remote.channel = null;
      live.remote.devices = null;
      live.remote.presence = null;
    },
    pair(id: string, state = 'online') {
      presence.set(id, state);
      for (const fn of pairListeners) fn();
    },
    unpair(id: string) {
      presence.delete(id);
      for (const fn of pairListeners) fn();
    },
    listeners: () => pairListeners.size,
  };
  const changes: any[] = [];
  let tray = 0;
  const flag = { on: opts.flag ?? true };
  const alwaysOn = createAlwaysOn({
    app,
    BrowserWindow,
    powerSaveBlocker,
    powerMonitor,
    userData,
    live,
    ignored: (what: string) => void log.push(`ignored:${what}`),
    platform: opts.platform ?? 'darwin',
    flagOn: () => flag.on,
    refreshTray: () => void tray++,
    onChange: (s: unknown) => changes.push(s),
  });
  return {
    alwaysOn,
    power,
    app,
    log,
    windows,
    makeWindow,
    remote,
    live,
    changes,
    userData,
    flag,
    trays: () => tray,
    file: path.join(userData, 'always-on.json'),
  };
}
