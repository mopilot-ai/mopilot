// electron/capabilities/controlIndicator.cjs: the "using your computer" overlay (one click-through,
// capture-excluded window per display) and the global Esc shortcut while a chat holds the desktop,
// over a mocked Electron BrowserWindow, screen and globalShortcut.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ControlIndicator, overlayHtml, shownCss, labelCss, LABEL, FADE_MS } = require('../electron/capabilities/controlIndicator.cjs');
/** lets pending promise callbacks and short timers run */
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function fakeElectron(
  o: {
    displays?: any[];
    registerOk?: boolean;
    registerThrows?: boolean;
    unregisterThrows?: boolean;
    displaysThrow?: boolean;
    makeThrows?: boolean;
    loadOk?: boolean;
    insertThrows?: boolean;
    removeThrows?: boolean;
  } = {},
) {
  const windows: any[] = [];
  const log: any[] = [];
  const shortcuts = new Map<string, Function>();
  let displays = o.displays ?? [{ bounds: { x: 0, y: 0, width: 1440, height: 900 } }];
  class BrowserWindow {
    opts: any;
    calls: any[] = [];
    destroyed = false;
    visible = false;
    throwOn = new Set<string>();
    constructor(opts: any) {
      if (o.makeThrows) throw new Error('no window');
      this.opts = opts;
      windows.push(this);
    }
    private rec(name: string, ...args: any[]) {
      this.calls.push([name, ...args]);
      if (this.throwOn.has(name)) throw new Error(`${name} failed`);
    }
    setIgnoreMouseEvents(...a: any[]) {
      this.rec('setIgnoreMouseEvents', ...a);
    }
    setAlwaysOnTop(...a: any[]) {
      this.rec('setAlwaysOnTop', ...a);
    }
    setVisibleOnAllWorkspaces(...a: any[]) {
      this.rec('setVisibleOnAllWorkspaces', ...a);
    }
    setContentProtection(...a: any[]) {
      this.rec('setContentProtection', ...a);
    }
    loadURL(url: string) {
      this.rec('loadURL', url);
      return o.loadOk ? Promise.resolve() : Promise.reject(new Error('aborted'));
    }
    sheets: string[] = [];
    nextKey = 0;
    webContents = {
      insertCSS: async (css: string) => {
        this.rec('insertCSS', css);
        if (o.insertThrows) throw new Error('insert failed');
        const key = `k${++this.nextKey}`;
        this.sheets.push(key);
        return key;
      },
      removeInsertedCSS: async (key: string) => {
        this.rec('removeInsertedCSS', key);
        if (o.removeThrows) throw new Error('remove failed');
        this.sheets = this.sheets.filter((k) => k !== key);
      },
    };
    setBounds(b: any) {
      this.rec('setBounds', b);
    }
    showInactive() {
      this.rec('showInactive');
      this.visible = true;
    }
    hide() {
      this.rec('hide');
      this.visible = false;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.rec('destroy');
      this.destroyed = true;
    }
  }
  const globalShortcut = {
    register: (accel: string, fn: Function) => {
      log.push(['register', accel]);
      if (o.registerThrows) throw new Error('taken');
      if (o.registerOk === false) return false;
      shortcuts.set(accel, fn);
      return true;
    },
    unregister: (accel: string) => {
      log.push(['unregister', accel]);
      shortcuts.delete(accel);
      if (o.unregisterThrows) throw new Error('gone');
    },
  };
  const screen = {
    getAllDisplays: () => {
      if (o.displaysThrow) throw new Error('no screen');
      return displays;
    },
  };
  return {
    electron: { BrowserWindow, screen, globalShortcut },
    windows,
    log,
    shortcuts,
    setDisplays: (d: any[]) => {
      displays = d;
    },
    press: () => shortcuts.get('Escape')?.(),
  };
}

test('overlay page: the label escaped, no script allowed, clicks pass through', () => {
  const html = overlayHtml('<b>"A & B"</b>');
  assert.match(html, /&lt;b&gt;&quot;A &amp; B&quot;&lt;\/b&gt;/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /pointer-events:none/);
  assert.doesNotMatch(html, /<script/);
  assert.match(overlayHtml(), /The agent is using your computer · Esc to stop/);
  assert.equal(LABEL, 'The agent is using your computer · Esc to stop');
});

test("overlay motion is Claude Desktop's: 0.3s fade, 2s glow pulse, 1.8s dot pulse, 6s badge flight", () => {
  const html = overlayHtml();
  assert.match(html, /#overlay\{opacity:0;transition:opacity \.3s ease-in-out\}/);
  assert.match(html, /animation:glow-pulse 2s ease-in-out infinite/);
  assert.match(
    html,
    /inset 0 0 50px rgba\(92,143,255,0\.5\),inset 0 0 100px rgba\(92,143,255,0\.3\),inset 0 0 150px rgba\(92,143,255,0\.1\)/,
  );
  assert.match(
    html,
    /50%\{box-shadow:inset 0 0 65px rgba\(92,143,255,0\.7\),inset 0 0 115px rgba\(92,143,255,0\.5\),inset 0 0 165px rgba\(92,143,255,0\.2\)\}/,
  );
  assert.match(html, /animation:dot-pulse 1\.8s ease-in-out infinite/);
  // Claude's flight, under two names; it ends in the top-right corner instead of fading out there
  const claude =
    '0%{opacity:0;top:50%;left:50%;transform:translate(-50%,-50%) scale(1.4)}5%{opacity:1;top:50%;left:50%;transform:translate(-50%,-50%) scale(1.4)}88%{opacity:1;top:50%;left:50%;transform:translate(-50%,-50%) scale(1.4)}';
  const corner = 'opacity:1;top:40px;left:calc(100% - 40px);transform:translate(-100%,0) scale(.8)';
  for (const name of ['badge-flight-a', 'badge-flight-b']) assert.ok(html.includes(`@keyframes ${name}{${claude}100%{${corner}}}`), name);
  assert.match(html, /prefers-reduced-motion:reduce\)\{#glow,#badge-dot\{animation:none\}/);
  // the badge only shows once a sheet is in
  assert.doesNotMatch(html, /#badge\{[^}]*animation/);
  assert.match(html, /#badge\{[^}]*opacity:0\}/);
  // each sheet: the overlay fades in, the badge rests in the corner (all reduced motion gets) and flies there
  // under the other name from the sheet before
  assert.ok(shownCss(1).startsWith(`#overlay{opacity:1}#badge{${corner}}@media (prefers-reduced-motion:no-preference)`));
  assert.match(shownCss(1), /\{#badge\{animation:badge-flight-b 6s cubic-bezier\(\.4,0,\.2,1\) 1 forwards\}\}$/);
  assert.match(shownCss(2), /animation:badge-flight-a 6s/);
  assert.equal(FADE_MS, 320);
});

test('a chat taking control shows one click-through, capture-excluded window per display and binds Esc', () => {
  const e = fakeElectron({
    displays: [{ bounds: { x: 0, y: 0, width: 1440, height: 900 } }, { bounds: { x: 1440, y: 0, width: 1920, height: 1080 } }],
  });
  const stops: string[] = [];
  const ind = new ControlIndicator({ electron: e.electron, onEscape: (c: string) => stops.push(c), label: 'Custom label' });
  ind.sync('c1');
  assert.equal(e.windows.length, 2);
  const [w] = e.windows;
  assert.equal(w.opts.focusable, false);
  assert.equal(w.opts.transparent, true);
  assert.equal(w.opts.webPreferences.javascript, false);
  assert.deepEqual(w.calls.slice(0, 4), [
    ['setIgnoreMouseEvents', true],
    ['setAlwaysOnTop', true, 'screen-saver'],
    ['setVisibleOnAllWorkspaces', true, { visibleOnFullScreen: true }],
    ['setContentProtection', true],
  ]);
  assert.match(decodeURIComponent(w.calls[4][1]), /Custom label/);
  assert.deepEqual(
    e.windows.map((x: any) => x.calls.find((c: any) => c[0] === 'setBounds')[1]),
    [
      { x: 0, y: 0, width: 1440, height: 900 },
      { x: 1440, y: 0, width: 1920, height: 1080 },
    ],
  );
  assert.ok(e.windows.every((x: any) => x.visible));
  assert.deepEqual(e.log, [['register', 'Escape']]);
  // Esc stops the chat holding control
  e.press();
  assert.deepEqual(stops, ['c1']);
  // the same chat again: nothing changes
  ind.sync('c1');
  assert.equal(e.windows.length, 2);
  assert.equal(e.log.length, 1);
});

test('control ends: Esc is given back and the overlay hides; the windows are reused next time', async () => {
  const e = fakeElectron();
  const ind = new ControlIndicator({ electron: e.electron, fadeMs: 1 });
  ind.sync('c1');
  ind.sync(null);
  assert.deepEqual(e.log, [
    ['register', 'Escape'],
    ['unregister', 'Escape'],
  ]);
  assert.equal(e.windows[0].visible, true, 'up while it fades out');
  await settle();
  assert.equal(e.windows[0].visible, false);
  assert.equal(ind.chatId, null);
  ind.sync('');
  assert.equal(e.log.length, 2, 'an empty id is no chat: nothing to undo twice');
  ind.sync('c2');
  assert.equal(e.windows.length, 1, 'reused');
  assert.equal(e.windows[0].visible, true);
  // a destroyed window is replaced, an extra display's window is destroyed
  e.windows[0].destroyed = true;
  ind.sync(null);
  ind.sync('c3');
  assert.equal(e.windows.length, 2);
  assert.equal(e.windows[1].visible, true);
  e.setDisplays([]);
  ind.sync(null);
  ind.sync('c4');
  assert.ok(e.windows[1].calls.some((c: any) => c[0] === 'destroy'));
  ind.dispose();
  assert.equal(ind.windows.length, 0);
});

test('a default onEscape and a missing Electron do nothing, without throwing', () => {
  const none = new ControlIndicator({ electron: null });
  none.sync('c1');
  none.sync(null);
  none.dispose();
  const e = fakeElectron();
  const ind = new ControlIndicator({ electron: e.electron });
  ind.sync('c1');
  e.press();
  // the shortcut fires after control moved on: no chat to stop
  const handler = e.shortcuts.get('Escape')!;
  ind.chatId = null;
  handler();
  ind.dispose();
});

test('Electron failures never break control: displays, windows, registering and unregistering Esc', () => {
  const noScreen = fakeElectron({ displaysThrow: true });
  const a = new ControlIndicator({ electron: noScreen.electron });
  a.sync('c1');
  assert.equal(noScreen.windows.length, 0);
  const noWindow = fakeElectron({ makeThrows: true });
  const b = new ControlIndicator({ electron: noWindow.electron });
  b.sync('c1');
  assert.equal(b.windows.length, 0);
  const taken = fakeElectron({ registerThrows: true });
  const c = new ControlIndicator({ electron: taken.electron });
  c.sync('c1');
  assert.equal(c.escape, false);
  c.sync(null);
  assert.deepEqual(taken.log, [['register', 'Escape']], 'nothing to unregister');
  const refused = fakeElectron({ registerOk: false });
  const d = new ControlIndicator({ electron: refused.electron });
  d.sync('c1');
  assert.equal(d.escape, false);
  const sticky = fakeElectron({ unregisterThrows: true });
  const f = new ControlIndicator({ electron: sticky.electron });
  f.sync('c1');
  f.sync(null);
  assert.equal(f.escape, false);
  // window calls that throw
  const flaky = fakeElectron();
  const g = new ControlIndicator({ electron: flaky.electron });
  g.sync('c1');
  const [w] = flaky.windows;
  w.throwOn = new Set(['setBounds', 'hide', 'destroy']);
  g.sync(null);
  g.sync('c2');
  flaky.setDisplays([]);
  g.sync(null);
  g.sync('c3');
  g.dispose();
  // dispose destroys what is left, ignoring failures
  const h = fakeElectron();
  const k = new ControlIndicator({ electron: h.electron });
  k.sync('c1');
  h.windows[0].throwOn = new Set(['destroy']);
  k.dispose();
  assert.equal(k.windows.length, 0);
});

test('suspendEscape lifts the shortcut while the agent sends Escape itself, nested, and rebinds after', async () => {
  const e = fakeElectron();
  // no settle delay here: CM-Q15 (controlMatrixCuEscape) covers it
  const ind = new ControlIndicator({ electron: e.electron, escapeSettleMs: 0 });
  ind.sync('c1');
  const seen: boolean[] = [];
  const out = await ind.suspendEscape(async () => {
    seen.push(e.shortcuts.has('Escape'));
    await ind.suspendEscape(async () => seen.push(e.shortcuts.has('Escape')));
    seen.push(e.shortcuts.has('Escape'));
    return 'pressed';
  });
  assert.equal(out, 'pressed');
  assert.deepEqual(seen, [false, false, false], 'not rebound while an outer suspension runs');
  assert.equal(e.shortcuts.has('Escape'), true);
  // a failing press still rebinds
  await assert.rejects(
    ind.suspendEscape(async () => {
      throw new Error('key failed');
    }),
    /key failed/,
  );
  assert.equal(e.shortcuts.has('Escape'), true);
  // control ended during the press: not rebound
  await ind.suspendEscape(async () => ind.sync(null));
  assert.equal(e.shortcuts.has('Escape'), false);
  // while suspended, taking control does not bind Esc
  await ind.suspendEscape(async () => {
    ind.sync('c2');
    assert.equal(e.shortcuts.has('Escape'), false);
  });
  assert.equal(e.shortcuts.has('Escape'), true);
});

test('showing fades the overlay in once the page has loaded; hiding fades it out, then hides the windows', async () => {
  const e = fakeElectron({ loadOk: true });
  const ind = new ControlIndicator({ electron: e.electron, fadeMs: 20 });
  ind.sync('c1');
  const [w] = e.windows;
  assert.deepEqual(w.sheets, [], 'nothing until the page has loaded');
  await settle();
  assert.deepEqual(w.sheets, ['k1']);
  assert.deepEqual(
    w.calls.find((c: any) => c[0] === 'insertCSS'),
    ['insertCSS', shownCss(1)],
  );
  ind.sync(null);
  await settle();
  assert.deepEqual(w.sheets, [], 'the sheet comes out: the 0.3s fade-out runs');
  assert.equal(w.visible, true, 'still up while it fades');
  await settle(40);
  assert.equal(w.visible, false);
  ind.dispose();
});

test('shown again while fading out: the windows stay up and the badge flight restarts', async () => {
  const e = fakeElectron({ loadOk: true });
  const ind = new ControlIndicator({ electron: e.electron, fadeMs: 15 });
  ind.sync('c1');
  await settle();
  ind.sync(null);
  ind.sync('c2');
  await settle(40);
  const [w] = e.windows;
  assert.equal(w.visible, true, 'the earlier fade-out never hid it');
  assert.deepEqual(w.sheets, ['k2']);
  // control passes straight to another chat: the new sheet goes in before the old one comes out (no frame
  // without it), and it names the flight differently, so the badge flies again
  ind.sync('c3');
  await settle();
  assert.deepEqual(w.sheets, ['k3']);
  const order = w.calls
    .filter((c: any) => c[0] === 'insertCSS' || c[0] === 'removeInsertedCSS')
    .map((c: any) => (c[0] === 'insertCSS' ? c[1].match(/badge-flight-\w/)[0] : c[1]));
  assert.deepEqual(order, ['badge-flight-b', 'k1', 'badge-flight-a', 'badge-flight-b', 'k2']);
  ind.dispose();
});

test('hidden before the sheet went in: it is taken out again as soon as it lands', async () => {
  const e = fakeElectron({ loadOk: true });
  const ind = new ControlIndicator({ electron: e.electron, fadeMs: 1 });
  ind.sync('c1');
  const [w] = e.windows;
  // the page loads, the sheet is on its way in, then control ends
  const insert = w.webContents.insertCSS;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  w.webContents.insertCSS = async (css: string) => {
    await gate;
    return insert(css);
  };
  await settle();
  ind.sync(null);
  release();
  await settle(10);
  assert.deepEqual(w.sheets, []);
  assert.equal(w.visible, false);
  // and hidden before the page even loaded: no sheet at all
  ind.sync('c2');
  ind.sync(null);
  await settle(10);
  assert.deepEqual(w.sheets, []);
  ind.dispose();
});

test('fade failures and windows destroyed mid-fade never break control', async () => {
  const noInsert = fakeElectron({ loadOk: true, insertThrows: true });
  const a = new ControlIndicator({ electron: noInsert.electron, fadeMs: 1 });
  a.sync('c1');
  await settle();
  assert.deepEqual(noInsert.windows[0].sheets, []);
  a.sync(null);
  await settle();
  a.dispose();
  const noRemove = fakeElectron({ loadOk: true, removeThrows: true });
  const b = new ControlIndicator({ electron: noRemove.electron, fadeMs: 1 });
  b.sync('c1');
  await settle();
  b.sync(null);
  await settle();
  assert.equal(noRemove.windows[0].visible, false, 'hidden even when the sheet would not come out');
  // the stuck sheet is still listed: the next show takes it out after its own goes in
  b.sync('c2');
  await settle();
  const removes = noRemove.windows[0].calls.filter((c: any) => c[0] === 'removeInsertedCSS').map((c: any) => c[1]);
  assert.deepEqual(removes, ['k1', 'k1']);
  b.dispose();
  // destroyed while its page loads, or while shown
  const gone = fakeElectron({ loadOk: true });
  const c = new ControlIndicator({ electron: gone.electron, fadeMs: 1 });
  c.sync('c1');
  gone.windows[0].destroyed = true;
  await settle();
  assert.deepEqual(gone.windows[0].sheets, []);
  c.sync(null);
  c.sync('c2');
  await settle();
  const w2 = gone.windows[1];
  assert.deepEqual(w2.sheets, ['k1']);
  w2.destroyed = true;
  c.sync(null);
  await settle();
  assert.deepEqual(w2.sheets, ['k1'], 'a destroyed window is left alone');
  c.dispose();
  // when the fade-out ends: a destroyed window is skipped, a failing hide is noted and the rest still hide
  const two = fakeElectron({
    loadOk: true,
    displays: [{ bounds: { x: 0, y: 0, width: 1, height: 1 } }, { bounds: { x: 1, y: 0, width: 1, height: 1 } }],
  });
  const d = new ControlIndicator({ electron: two.electron, fadeMs: 1 });
  d.sync('c1');
  await settle();
  const [x, y] = two.windows;
  d.sync(null);
  x.throwOn = new Set(['hide']);
  y.destroyed = true;
  await settle(10);
  assert.ok(x.calls.some((c: any) => c[0] === 'hide'));
  assert.ok(!y.calls.some((c: any) => c[0] === 'hide'));
  x.throwOn = new Set();
  d.dispose();
});

test('a paired device holding this Mac is named on the badge (#1364); a chat here keeps the usual label', async () => {
  const e = fakeElectron({ loadOk: true });
  const label = (id: string) => (id === 'remote' ? 'Du’s "Laptop" \\ is using your computer · Esc to stop' : null);
  const ind = new ControlIndicator({ electron: e.electron, fadeMs: 5, labelFor: label });
  ind.sync('remote');
  await settle();
  const [w] = e.windows;
  const css = w.calls.find((c: any) => c[0] === 'insertCSS')[1];
  assert.equal(css, shownCss(1, false, label('remote')));
  assert.match(css, /#badge>span\{display:none\}#badge::after\{content:"Du’s \\"Laptop\\" \\\\ is using your computer · Esc to stop"\}/);
  ind.sync('local');
  await settle();
  assert.equal(w.calls.filter((c: any) => c[0] === 'insertCSS').at(-1)[1], shownCss(2));
  // no labelFor: the page's own label
  assert.equal(new ControlIndicator({ electron: null }).labelFor('x'), null);
  // control characters can't end the string early
  assert.equal(labelCss('a\nb'), '#badge>span{display:none}#badge::after{content:"a b"}');
  assert.equal(labelCss(null), '');
  ind.dispose();
});
