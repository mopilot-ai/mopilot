// The user-triggered renderer CPU profile (electron/perf/cpuProfile.cjs) on a fake debugger, and its Help menu item.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCpuProfiler, DURATION_MS, INTERVAL_US } = require('../electron/perf/cpuProfile.cjs');
const { createMenus } = require('../electron/app/menu.cjs');

/** A BrowserWindow with a webContents.debugger that records its commands. */
function fakeWindow(opts: { attached?: boolean; attachThrows?: boolean; failOn?: string; disableFails?: boolean } = {}) {
  const log: string[] = [];
  const handlers: Record<string, () => void> = {};
  const state = { attached: !!opts.attached, destroyed: false };
  const debuggerFake = {
    isAttached: () => state.attached,
    attach: (v: string) => {
      if (opts.attachThrows) throw new Error('already attached');
      log.push(`attach ${v}`);
      state.attached = true;
    },
    detach: () => {
      log.push('detach');
      state.attached = false;
    },
    on: (e: string, fn: () => void) => void (handlers[e] = fn),
    removeListener: (e: string) => void delete handlers[e],
    sendCommand: async (m: string, p?: object) => {
      log.push(p ? `${m} ${JSON.stringify(p)}` : m);
      if (m === opts.failOn) throw new Error(`${m} failed`);
      if (m === 'Profiler.disable' && opts.disableFails) throw new Error('gone');
      return m === 'Profiler.stop' ? { profile: { nodes: [], samples: [1] } } : {};
    },
  };
  const win = { isDestroyed: () => state.destroyed, webContents: { debugger: debuggerFake } };
  return { win: win as any, log, handlers, state };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-profile-'));
/** A wait that resolves when the test says so. */
function manualWait() {
  let release: () => void = () => undefined;
  const make = () => {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((r) => (resolve = r));
    release = resolve;
    return { promise, cancel: resolve };
  };
  return { make, release: () => release() };
}

test('captures a 1 ms profile, writes it and reveals the file, then detaches', async () => {
  const dir = tmp();
  const f = fakeWindow();
  const revealed: string[] = [];
  const waits: number[] = [];
  let started = 0;
  const p = createCpuProfiler({
    dir: () => dir,
    wait: (ms: number) => (waits.push(ms), { promise: Promise.resolve(), cancel() {} }),
    reveal: (file: string) => revealed.push(file),
    id: () => 'run1',
  });
  const r = await p.capture(f.win, { onStart: () => started++ });
  assert.deepEqual(r, { ok: true, file: path.join(dir, 'profile-run1.cpuprofile') });
  assert.deepEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')), { nodes: [], samples: [1] });
  assert.deepEqual(revealed, [r.file]);
  assert.deepEqual(waits, [DURATION_MS]);
  assert.equal(started, 1);
  assert.equal(INTERVAL_US, 1000);
  assert.deepEqual(f.log, [
    'attach 1.3',
    'Profiler.enable',
    'Profiler.setSamplingInterval {"interval":1000}',
    'Profiler.start',
    'Profiler.stop',
    'Profiler.disable',
    'detach',
  ]);
  assert.equal(f.state.attached, false);
});

test('default wait, default id and no onStart work end to end', async () => {
  const dir = tmp();
  const f = fakeWindow();
  const r = await createCpuProfiler({ dir: () => dir, durationMs: 1 }).capture(f.win);
  assert.equal(r.ok, true);
  assert.match(path.basename(r.file), /^profile-.+\.cpuprofile$/);
});

test('refuses without a window or with a destroyed one', async () => {
  const p = createCpuProfiler({ dir: tmp });
  assert.deepEqual(await p.capture(null), { ok: false, reason: 'no-window' });
  const f = fakeWindow();
  f.state.destroyed = true;
  assert.deepEqual(await p.capture(f.win), { ok: false, reason: 'no-window' });
});

test('refuses when a debugger is already attached and leaves it attached', async () => {
  const f = fakeWindow({ attached: true });
  const r = await createCpuProfiler({ dir: tmp }).capture(f.win);
  assert.deepEqual(r, { ok: false, reason: 'attached' });
  assert.deepEqual(f.log, []);
  assert.equal(f.state.attached, true);
});

test('an attach failure is reported and nothing is detached', async () => {
  const f = fakeWindow({ attachThrows: true });
  const r = await createCpuProfiler({ dir: tmp }).capture(f.win);
  assert.deepEqual(r, { ok: false, reason: 'attach-failed', message: 'already attached' });
  assert.deepEqual(f.log, []);
});

test('a second start while one records is refused, and a new one works after it ends', async () => {
  const m = manualWait();
  const dir = tmp();
  const p = createCpuProfiler({ dir: () => dir, wait: m.make, id: () => 'a' });
  const first = p.capture(fakeWindow().win);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await p.capture(fakeWindow().win), { ok: false, reason: 'busy' });
  m.release();
  assert.equal((await first).ok, true);
  const again = p.capture(fakeWindow().win);
  await new Promise((r) => setImmediate(r));
  m.release();
  assert.equal((await again).ok, true);
});

test('the window closing mid-capture ends it early, writes nothing and releases the guard', async () => {
  const m = manualWait();
  const dir = tmp();
  const f = fakeWindow();
  const p = createCpuProfiler({ dir: () => dir, wait: m.make });
  const run = p.capture(f.win);
  await new Promise((r) => setImmediate(r));
  f.state.attached = false; // Electron detaches when the window closes
  f.handlers.detach();
  assert.deepEqual(await run, { ok: false, reason: 'window-closed' });
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(f.log.includes('detach'), false);
  assert.equal((await createCpuProfiler({ dir: () => dir, durationMs: 1 }).capture(fakeWindow().win)).ok, true);
});

test('a destroyed window that rejects commands counts as closed', async () => {
  const f = fakeWindow({ failOn: 'Profiler.start' });
  const sc = f.win.webContents.debugger.sendCommand;
  f.win.webContents.debugger.sendCommand = async (m: string, p?: object) => {
    if (m === 'Profiler.start') f.state.destroyed = true;
    return sc(m, p);
  };
  const r = await createCpuProfiler({ dir: tmp }).capture(f.win);
  assert.deepEqual(r, { ok: false, reason: 'window-closed' });
});

test('a debugger error detaches and reports it; a failed Profiler.disable is ignored', async () => {
  const f = fakeWindow({ failOn: 'Profiler.stop', disableFails: true });
  const r = await createCpuProfiler({ dir: tmp, wait: () => ({ promise: Promise.resolve(), cancel() {} }) }).capture(f.win);
  assert.deepEqual(r, { ok: false, reason: 'failed', message: 'Profiler.stop failed' });
  assert.equal(f.log.at(-1), 'detach');
  assert.equal(f.state.attached, false);
});

test('a write failure is reported, detaches and does not reveal', async () => {
  const f = fakeWindow();
  const revealed: string[] = [];
  const r = await createCpuProfiler({
    dir: tmp,
    wait: () => ({ promise: Promise.resolve(), cancel() {} }),
    write: async () => {
      throw new Error('disk full');
    },
    reveal: (x: string) => revealed.push(x),
  }).capture(f.win);
  assert.deepEqual(r, { ok: false, reason: 'failed', message: 'disk full' });
  assert.deepEqual(revealed, []);
  assert.equal(f.state.attached, false);
});

test('a detach that throws is recorded, not raised', async () => {
  const f = fakeWindow();
  f.win.webContents.debugger.detach = () => {
    throw new Error('boom');
  };
  const r = await createCpuProfiler({ dir: tmp, durationMs: 1 }).capture(f.win);
  assert.equal(r.ok, true);
});

test('a non-Error rejection is reported as text', async () => {
  const f = fakeWindow();
  f.win.webContents.debugger.sendCommand = async () => {
    throw 'plain';
  };
  const r = await createCpuProfiler({ dir: tmp }).capture(f.win);
  assert.deepEqual(r, { ok: false, reason: 'failed', message: 'plain' });
});

/** The Help menu item, through the real menu template. */
function menuItem(opts: { win: any; focused?: any; dialogFails?: boolean }) {
  const dialogs: any[] = [];
  const notes: any[] = [];
  const shown: string[] = [];
  const dir = tmp();
  let template: any[] = [];
  const windows = new Set<any>(opts.win ? [opts.win] : []);
  const menus = createMenus({
    Menu: { buildFromTemplate: (t: any[]) => t, setApplicationMenu: (t: any[]) => void (template = t) },
    Tray: class {},
    nativeImage: {},
    globalShortcut: {},
    shell: { showItemInFolder: (f: string) => shown.push(f), openExternal: () => undefined },
    BrowserWindow: { getFocusedWindow: () => opts.focused ?? null },
    APP_NAME: 'MoPilot',
    isDev: false,
    isWin: false,
    win: {
      windows,
      mainWindow: () => opts.win,
      createWindow() {},
      showMainWindow: async () => {},
      commandMainWindow: async () => {},
      toggleMini() {},
    },
    live: {},
    notice: (n: any) => notes.push(n),
    native: () => ({
      dialog: {
        showMessageBox: async (o: any) => {
          dialogs.push(o);
          if (opts.dialogFails) throw new Error('no dialog');
        },
      },
      app: { getPath: () => dir },
    }),
  });
  menus.buildMenu();
  const help = template.find((m) => m.role === 'help').submenu;
  const item = help.find((i: any) => i.label === 'Capture Performance Profile…');
  return { item, dialogs, notes, shown, dir };
}

test('Help > Capture Performance Profile records the focused window and reveals the file', async () => {
  const f = fakeWindow();
  const m = menuItem({ win: f.win, focused: f.win });
  const original = setTimeout;
  // shorten the 10 s wait without touching the controller's default
  (globalThis as any).setTimeout = (fn: () => void) => original(fn, 0);
  try {
    await m.item.click();
    await new Promise((r) => original(r, 20));
  } finally {
    (globalThis as any).setTimeout = original;
  }
  assert.equal(m.notes.length, 1);
  assert.equal(m.shown.length, 1);
  assert.equal(m.shown[0].startsWith(path.join(m.dir, 'perf')), true);
  assert.deepEqual(m.dialogs, []);
});

test('Help > Capture Performance Profile explains why it could not, and uses the main window without focus', async () => {
  const f = fakeWindow({ attached: true });
  const m = menuItem({ win: f.win });
  await m.item.click();
  await new Promise((r) => setImmediate(r));
  assert.equal(m.dialogs.length, 1);
  assert.match(m.dialogs[0].message, /DevTools is open/);
  assert.deepEqual(m.notes, []);
});

test('Help > Capture Performance Profile with a failing dialog is ignored, not raised', async () => {
  const m = menuItem({ win: null, dialogFails: true });
  await m.item.click();
  await new Promise((r) => setImmediate(r));
  assert.match(m.dialogs[0].message, /No window/);
});

test('the default wait is cut short by a closing window', async () => {
  const f = fakeWindow();
  const run = createCpuProfiler({ dir: tmp }).capture(f.win);
  await new Promise((r) => setTimeout(r, 20));
  f.handlers.detach();
  assert.deepEqual(await run, { ok: false, reason: 'window-closed' });
});

test('the menu item without injected Electron modules fails safe', async () => {
  let template: any[] = [];
  const menus = createMenus({
    Menu: { buildFromTemplate: (t: any[]) => t, setApplicationMenu: (t: any[]) => void (template = t) },
    Tray: class {},
    nativeImage: {},
    globalShortcut: {},
    shell: { openExternal: () => undefined },
    BrowserWindow: { getFocusedWindow: () => null },
    APP_NAME: 'MoPilot',
    isDev: false,
    isWin: false,
    win: {
      windows: new Set(),
      mainWindow: () => null,
      createWindow() {},
      showMainWindow: async () => {},
      commandMainWindow: async () => {},
      toggleMini() {},
    },
    live: {},
  });
  menus.buildMenu();
  const item = template.find((m) => m.role === 'help').submenu.find((i: any) => i.label === 'Capture Performance Profile…');
  await item.click();
});

test('a command that fails because the debugger detached counts as a closed window', async () => {
  const f = fakeWindow();
  f.win.webContents.debugger.sendCommand = async (m: string) => {
    if (m === 'Profiler.start') {
      f.state.attached = false;
      f.handlers.detach();
      throw new Error('Target closed');
    }
    return {};
  };
  assert.deepEqual(await createCpuProfiler({ dir: tmp }).capture(f.win), { ok: false, reason: 'window-closed' });
});

test('a window that closes before the wait starts ends at once, and a new capture is refused as busy until the debugger is released', async () => {
  const f = fakeWindow();
  const sc = f.win.webContents.debugger.sendCommand;
  let release: () => void = () => undefined;
  f.win.webContents.debugger.sendCommand = async (m: string, p?: object) => {
    if (m === 'Profiler.start') f.handlers.detach();
    if (m === 'Profiler.disable') await new Promise<void>((r) => (release = r));
    return sc(m, p);
  };
  f.state.attached = true;
  const p = createCpuProfiler({ dir: tmp });
  f.state.attached = false;
  const run = p.capture(f.win);
  await new Promise((r) => setImmediate(r));
  // cleanup is waiting on Profiler.disable: still busy, not "attached"
  assert.deepEqual(await p.capture(fakeWindow().win), { ok: false, reason: 'busy' });
  release();
  assert.deepEqual(await run, { ok: false, reason: 'window-closed' });
});
