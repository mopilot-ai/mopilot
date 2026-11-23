// Exercises the real always-on controller over Electron's own app, windows and power-save blocker with a fake remote runtime: with the last window gone the process and the runtime stay up, the sleep blocker holds while a phone is connected and is released with the last pair.
import path from 'node:path';
import { test, expect } from './fixtures/app';

test.skip(
  process.platform !== 'darwin',
  'closing the last window keeps the app up only on macOS (Windows needs the tray item, covered in unit tests)',
);

test('closing the last window keeps Mobile Remote up; the sleep blocker follows the connected phone', async ({ harness }) => {
  const entry = path.resolve(__dirname, '../../electron/app/alwaysOn.cjs');
  const result = await harness.app.evaluate(async ({ app, BrowserWindow, powerSaveBlocker }, file) => {
    const require = process.getBuiltinModule('module').createRequire(file);
    const fs = process.getBuiltinModule('fs');
    const os = process.getBuiltinModule('os');
    const path = process.getBuiltinModule('path');
    const { createAlwaysOn } = require(file);
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'always-on-'));
    try {
      const presence = new Map<string, string>();
      const listeners = new Set<() => void>();
      const channel = {
        pairs: () => [...presence.keys()],
        statsOf: () => null,
        closedReason: () => null,
        presence: (p: string) => presence.get(p) ?? 'gone',
        onPairsChanged: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)),
      };
      const live = {
        remote: {
          running: true,
          channel,
          devices: { list: () => [...presence.keys()].map((id) => ({ id, pairId: id, name: id })), isRetired: () => false },
          presence: { isOnline: (id: string) => presence.get(id) === 'online', isAbsent: (id: string) => presence.get(id) !== 'online' },
        },
      };
      let blocker = -1;
      const alwaysOn = createAlwaysOn({
        app,
        BrowserWindow,
        powerSaveBlocker: {
          start: (type: any) => (blocker = powerSaveBlocker.start(type)),
          stop: (id: number) => powerSaveBlocker.stop(id),
          isStarted: (id: number) => powerSaveBlocker.isStarted(id),
        },
        userData,
        live,
        ignored: () => undefined,
        refreshTray: () => undefined,
        flagOn: () => true,
      });
      alwaysOn.watchWindows();
      alwaysOn.set({ keepRunning: true, preventSleep: true });
      const windowsBefore = BrowserWindow.getAllWindows().length;
      // the last window closes: the app and the runtime must still be here
      for (const w of BrowserWindow.getAllWindows()) w.destroy();
      const windowsAfter = BrowserWindow.getAllWindows().length;
      presence.set('phone', 'online');
      for (const fn of listeners) fn();
      const held = blocker >= 0 && powerSaveBlocker.isStarted(blocker);
      presence.delete('phone');
      for (const fn of listeners) fn();
      const released = !powerSaveBlocker.isStarted(blocker);
      const state = alwaysOn.get();
      alwaysOn.close();
      return { windowsBefore, windowsAfter, ready: app.isReady(), held, released, active: state.active, remoteOn: state.remoteOn };
    } finally {
      fs.rmSync(userData, { recursive: true, force: true });
    }
  }, entry);
  expect(result.windowsBefore).toBeGreaterThan(0);
  expect(result).toMatchObject({ windowsAfter: 0, ready: true, held: true, released: true, active: true, remoteOn: true });
  // main still answers after the window is gone
  expect(await harness.app.evaluate(({ app }) => app.getName())).toBeTruthy();
});
