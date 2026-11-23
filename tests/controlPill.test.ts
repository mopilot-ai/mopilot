// electron/capabilities/controlPill.cjs: the clickable "{agent} is using your computer · Stop" pill (#1579), one small
// capture-excluded window per display, over a mocked Electron BrowserWindow and screen: where it sits, that a person's
// Stop click stops the chat, and that an agent's pointer action or Codex Computer Use never lands on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ControlPills,
  pillLabel,
  pillHtml,
  pillBounds,
  STOP_URL,
  OPEN_URL,
  ESC_HINT,
  LABEL,
  SIZE,
  INSET,
} = require('../electron/capabilities/controlPill.cjs');
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function fakeElectron(
  o: { displays?: any[]; displaysThrow?: boolean; makeThrows?: boolean; loadOk?: boolean; ignoreThrows?: boolean } = {},
) {
  const windows: any[] = [];
  let displays = o.displays ?? [{ bounds: { x: 0, y: 0, width: 1440, height: 900 } }];
  class BrowserWindow {
    opts: any;
    calls: any[] = [];
    destroyed = false;
    visible = false;
    handlers = new Map<string, Function>();
    openHandler: Function | null = null;
    constructor(opts: any) {
      if (o.makeThrows) throw new Error('no window');
      this.opts = opts;
      windows.push(this);
    }
    setIgnoreMouseEvents(v: boolean) {
      this.calls.push(['setIgnoreMouseEvents', v]);
      if (o.ignoreThrows) throw new Error('gone');
    }
    setAlwaysOnTop(...a: any[]) {
      this.calls.push(['setAlwaysOnTop', ...a]);
    }
    setVisibleOnAllWorkspaces(...a: any[]) {
      this.calls.push(['setVisibleOnAllWorkspaces', ...a]);
    }
    setContentProtection(v: boolean) {
      this.calls.push(['setContentProtection', v]);
    }
    loadURL(url: string) {
      this.calls.push(['loadURL', url]);
      return o.loadOk === false ? Promise.reject(new Error('aborted')) : Promise.resolve();
    }
    webContents = {
      on: (name: string, fn: Function) => this.handlers.set(name, fn),
      setWindowOpenHandler: (fn: Function) => {
        this.openHandler = fn;
      },
    };
    setBounds(b: any) {
      this.calls.push(['setBounds', b]);
    }
    showInactive() {
      this.visible = true;
    }
    isVisible() {
      return this.visible;
    }
    hide() {
      this.visible = false;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      if (this.destroyed) throw new Error('already destroyed');
      this.destroyed = true;
    }
    /** a click on a link: will-navigate, as Chromium sends it for a link without script */
    navigate(url: string) {
      let prevented = false;
      this.handlers.get('will-navigate')?.({ preventDefault: () => (prevented = true) }, url);
      return prevented;
    }
    ignoring() {
      return this.calls.filter((c) => c[0] === 'setIgnoreMouseEvents').at(-1)?.[1];
    }
  }
  const screen = {
    getAllDisplays: () => {
      if (o.displaysThrow) throw new Error('no screen');
      return displays;
    },
  };
  return { electron: { BrowserWindow, screen }, windows, setDisplays: (d: any[]) => (displays = d) };
}

const pills = (f: ReturnType<typeof fakeElectron>, more: Record<string, unknown> = {}) => {
  const stops: number[] = [];
  const p = new ControlPills({ electron: f.electron, onStop: () => stops.push(1), delayMs: 1, settleMs: 0, ...more });
  return { p, stops };
};

test('the pill page runs no script: Stop is a link, names are escaped, the CSP allows inline style and data: images', () => {
  const html = pillHtml({ agent: '<b>"x"</b> & co' });
  assert.ok(html.includes('>&lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; co is using your computer</a>'), 'the agent, then "your computer"');
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes(`content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"`));
  assert.ok(html.includes(`<a id="stop" href="${STOP_URL}"`));
  assert.ok(pillHtml().includes('>The agent is using your computer</a>') && LABEL === 'The agent is using your computer');
  // the person took over: the pill says so instead of naming the agent
  assert.equal(
    pillLabel({ agent: 'Codex', paused: true }),
    `<a id="label" href="${OPEN_URL}" draggable="false" title="Open the chat">You took over</a>`,
  );
  // the label opens the chat
  assert.ok(html.includes(`<a id="label" href="${OPEN_URL}"`));
});

test('click-through (Codex Computer Use), the page has no links and says how to stop', () => {
  const html = pillHtml({ agent: 'Codex' }, false);
  assert.ok(html.includes(`<span id="label">Codex is using your computer · ${ESC_HINT}</span>`));
  assert.equal(pillLabel({ agent: 'Codex', paused: true }, false), `<span id="label">You took over · ${ESC_HINT}</span>`);
  assert.ok(!html.includes('<a '));
  assert.ok(!html.includes(STOP_URL) && !html.includes(OPEN_URL));
});

test('a click on the label opens the chat; not while an agent clicks, click-through or taken down', async () => {
  const f = fakeElectron();
  const opened: number[] = [];
  const { p } = pills(f, { onOpen: () => opened.push(1) });
  p.show();
  await settle(10);
  const [w] = f.windows;
  assert.equal(w.navigate(OPEN_URL), true);
  assert.deepEqual(opened, [1]);
  await p.suspendPointer(async () => w.navigate(OPEN_URL));
  p.show(false);
  w.navigate(OPEN_URL);
  p.show(true);
  p.hide();
  w.navigate(OPEN_URL);
  assert.deepEqual(opened, [1]);
  // without a listener, a click still does nothing
  const bare = new ControlPills({ electron: f.electron, delayMs: 1 });
  bare.show();
  await settle(10);
  assert.equal(f.windows[1].navigate(OPEN_URL), true);
});

test('a pill sits in each display’s top-right corner, sized to the pill', () => {
  assert.deepEqual(pillBounds({ bounds: { x: 1440, y: -200, width: 1920, height: 1080 } }), {
    x: 1440 + 1920 - INSET - SIZE.width,
    y: -200 + INSET,
    ...SIZE,
  });
});

test('shown once the badge’s flight ends: a focusless, capture-excluded window per display that takes a person’s clicks', async () => {
  const f = fakeElectron({
    displays: [{ bounds: { x: 0, y: 0, width: 1440, height: 900 } }, { bounds: { x: 1440, y: 0, width: 1920, height: 1080 } }],
  });
  const { p } = pills(f, { delayMs: 20 });
  p.show();
  await settle(5);
  assert.equal(f.windows.length, 0, 'not before the flight ends');
  await settle(30);
  assert.equal(f.windows.length, 2);
  const [w] = f.windows;
  assert.equal(w.opts.focusable, false);
  assert.equal(w.opts.acceptFirstMouse, true);
  assert.equal(w.opts.webPreferences.javascript, false);
  assert.deepEqual(
    w.calls.filter((c: any[]) => c[0] !== 'loadURL' && c[0] !== 'setBounds'),
    [
      ['setAlwaysOnTop', true, 'screen-saver'],
      ['setVisibleOnAllWorkspaces', true, { visibleOnFullScreen: true }],
      ['setContentProtection', true],
      ['setIgnoreMouseEvents', false],
    ],
  );
  assert.deepEqual(
    f.windows[1].calls.find((c: any[]) => c[0] === 'setBounds')[1],
    pillBounds({ bounds: { x: 1440, y: 0, width: 1920, height: 1080 } }),
  );
  assert.deepEqual(w.openHandler(), { action: 'deny' });
  // shown again while up: the same windows, no second timer
  p.show();
  await settle(30);
  assert.equal(f.windows.length, 2);
  p.dispose();
  assert.ok(f.windows.every((x) => x.destroyed));
  assert.deepEqual(p.windows, []);
});

test('a person’s Stop click stops the chat; the navigation is always cancelled, and other links do nothing', async () => {
  const f = fakeElectron();
  const { p, stops } = pills(f);
  p.show();
  await settle(10);
  const [w] = f.windows;
  assert.equal(w.navigate('https://example.com/'), true);
  assert.deepEqual(stops, []);
  assert.equal(w.navigate(STOP_URL), true);
  assert.deepEqual(stops, [1]);
  // taken down: a late click stops nothing
  p.hide();
  assert.equal(w.visible, false);
  assert.equal(w.navigate(STOP_URL), true);
  assert.deepEqual(stops, [1]);
});

test('an agent’s pointer action runs with every pill click-through, and the pills take clicks again after it settles', async () => {
  const f = fakeElectron({
    displays: [{ bounds: { x: 0, y: 0, width: 800, height: 600 } }, { bounds: { x: 800, y: 0, width: 800, height: 600 } }],
  });
  const { p, stops } = pills(f, { settleMs: 15 });
  p.show();
  await settle(10);
  let during: unknown[] = [];
  const result = await p.suspendPointer(async () => {
    during = f.windows.map((w) => w.ignoring());
    // a Stop the agent's click would have hit is not a person's
    f.windows[0].navigate(STOP_URL);
    return 'clicked';
  });
  assert.equal(result, 'clicked');
  assert.deepEqual(during, [true, true]);
  assert.deepEqual(stops, []);
  // still click-through until the window server has delivered the click
  assert.deepEqual(
    f.windows.map((w) => w.ignoring()),
    [true, true],
  );
  await settle(25);
  assert.deepEqual(
    f.windows.map((w) => w.ignoring()),
    [false, false],
  );
  // overlapping actions: click-through until the last one settles; a failure still releases
  const a = p.suspendPointer(() => settle(10));
  await assert.rejects(
    p.suspendPointer(async () => {
      throw new Error('helper gone');
    }),
    /helper gone/,
  );
  await a;
  await settle(5);
  assert.equal(f.windows[0].ignoring(), true);
  await settle(25);
  assert.equal(f.windows[0].ignoring(), false);
  // no settle time: released at once
  const now = pills(fakeElectron()).p;
  now.show();
  await settle(10);
  await now.suspendPointer(async () => undefined);
  assert.equal(now.suspended, 0);
});

test('while Codex Computer Use holds the desktop the pill is click-through and a Stop it receives is not acted on', async () => {
  const f = fakeElectron();
  const { p, stops } = pills(f);
  p.show(false);
  await settle(10);
  const [w] = f.windows;
  assert.equal(w.ignoring(), true);
  w.navigate(STOP_URL);
  assert.deepEqual(stops, []);
  // the page says "Esc to stop", where the Stop button was
  const page = (win: any) => decodeURIComponent(win.calls.filter((c: any[]) => c[0] === 'loadURL').at(-1)[1]);
  assert.ok(page(w).includes(ESC_HINT) && !page(w).includes(STOP_URL));
  // the hold ends while the same chat keeps control: clickable again, with its Stop button
  p.show(true);
  assert.equal(w.ignoring(), false);
  assert.ok(page(w).includes(STOP_URL));
  // an unchanged state reloads nothing; a gone window is skipped
  const loads = w.calls.filter((c: any[]) => c[0] === 'loadURL').length;
  p.show(true);
  assert.equal(w.calls.filter((c: any[]) => c[0] === 'loadURL').length, loads);
  w.destroyed = true;
  p.show(false);
  assert.equal(w.calls.filter((c: any[]) => c[0] === 'loadURL').length, loads);
});

test('taken down before the flight ends: no pill appears; a removed display loses its pill', async () => {
  const f = fakeElectron({
    displays: [{ bounds: { x: 0, y: 0, width: 800, height: 600 } }, { bounds: { x: 800, y: 0, width: 800, height: 600 } }],
  });
  const { p } = pills(f, { delayMs: 15 });
  p.show();
  p.hide();
  await settle(30);
  assert.equal(f.windows.length, 0);
  p.show();
  await settle(30);
  assert.equal(f.windows.length, 2);
  p.hide();
  f.setDisplays([{ bounds: { x: 0, y: 0, width: 800, height: 600 } }]);
  p.show();
  await settle(30);
  assert.equal(p.windows.length, 1);
  assert.equal(f.windows[1].destroyed, true);
  // a destroyed window is made again
  p.hide();
  f.windows[0].destroyed = true;
  p.show();
  await settle(30);
  assert.equal(f.windows.length, 3);
});

test('the pill is a convenience: no screen, no window, a failed load or a gone window never throws', async () => {
  for (const o of [{ displaysThrow: true }, { makeThrows: true }, { loadOk: false }, { ignoreThrows: true }]) {
    const f = fakeElectron(o);
    const { p } = pills(f);
    p.show();
    await settle(10);
    await p.suspendPointer(async () => undefined);
    p.hide();
    p.dispose();
  }
  // a window that throws on hide and on destroy
  const f = fakeElectron();
  const { p } = pills(f);
  p.show();
  await settle(10);
  const [w] = f.windows;
  w.hide = () => {
    throw new Error('gone');
  };
  w.destroyed = false;
  p.hide();
  w.destroy();
  p.dispose();
  // a display removed after its window was destroyed elsewhere
  const g = fakeElectron({
    displays: [{ bounds: { x: 0, y: 0, width: 800, height: 600 } }, { bounds: { x: 800, y: 0, width: 800, height: 600 } }],
  });
  const q = pills(g).p;
  q.show();
  await settle(10);
  q.hide();
  g.windows[1].destroy();
  g.setDisplays([{ bounds: { x: 0, y: 0, width: 800, height: 600 } }]);
  q.show();
  await settle(10);
  assert.equal(q.windows.length, 1);
  // without Electron: nothing is shown
  const none = new ControlPills({ electron: null, onStop: () => undefined, delayMs: 1 });
  none.show();
  await settle(10);
  assert.deepEqual(none.windows, []);
  const bare = new ControlPills({});
  assert.equal(bare.delayMs > 5000, true);
  // until the indicator wires it, a Stop goes nowhere
  bare.onStop();
});

test('each show names the chat’s agent: a changed name reloads the pills; a stale, failed or hidden answer does not', async () => {
  const f = fakeElectron();
  const answers: Record<string, any> = {};
  const asked: string[] = [];
  const { p } = pills(f, {
    who: (chatId: string) =>
      new Promise((res, rej) => {
        asked.push(chatId);
        answers[chatId] = { res, rej };
      }),
  });
  const loads = () =>
    f.windows.flatMap((w: any) => w.calls.filter((c: any[]) => c[0] === 'loadURL').map((c: any[]) => decodeURIComponent(c[1])));
  p.show(true, 'c1');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(loads().length, 1);
  assert.match(loads()[0], />The agent is using your computer</);
  answers.c1.res({ agent: 'Claude' });
  await new Promise((r) => setTimeout(r, 0));
  assert.match(loads().at(-1), />Claude is using your computer</);
  // the same name again: nothing reloads
  p.show(true, 'c1');
  answers.c1.res({ agent: 'Claude' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(loads().length, 2);
  // a newer show wins over an older answer; a failed answer changes nothing
  p.show(true, 'c1');
  const stale = answers.c1;
  p.show(true, 'c2');
  stale.res({ agent: 'Stale' });
  answers.c2.rej(new Error('down'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(loads().length, 2);
  // taken down before the answer: nothing reloads
  p.show(true, 'c3');
  p.hide();
  answers.c3.res({ agent: 'Codex' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(loads().length, 2);
  assert.deepEqual(asked, ['c1', 'c1', 'c1', 'c2', 'c3']);
  p.dispose();
});

test('without a namer the pill says the agent is using the computer', async () => {
  const f = fakeElectron();
  const { p } = pills(f);
  p.show(true, 'c1');
  await new Promise((r) => setTimeout(r, 5));
  const loads = f.windows.flatMap((w: any) => w.calls.filter((c: any[]) => c[0] === 'loadURL').map((c: any[]) => decodeURIComponent(c[1])));
  // one page, never renamed: nobody answers who is using the computer
  assert.equal(loads.length, 1);
  assert.match(loads[0], />The agent is using your computer</);
  p.dispose();
});
