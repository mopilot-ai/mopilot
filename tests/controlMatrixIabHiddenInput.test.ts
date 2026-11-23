// The control matrix (docs/control-plane/matrix/K.md CM-K37 to CM-K39): input on an in-app browser tab no window shows.
// Such a tab is a main-owned view parked in a never-shown window (views.cjs): background agents, a chat whose pane is
// closed, a dev instance in the background, a computer access chat. Chromium keeps its widget hidden although the page
// reports itself visible, so a mouse or key event over CDP hangs and lands nowhere, or the first one after the view
// wakes is dropped: the first click on a form's submit button did nothing and the second submitted it (#1509). Every
// client that sends a view input emulates its focus first (focusForInput, views.cjs), as the Chrome host does for the
// user's background tabs (CM-Z22): the browser_* tools and browser_script on every harness (one browser host), the
// native Codex Browser plugin's raw CDP (its backend attaches the host's tab) and the older sage_browser_* tools.
// The fake debugger drops input Chromium would (browser-host-kit.ts FakeDebugger.dropped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { setup, tabOf, drive, viewTabs } from './support/browser-host-kit.ts';
import { withTab } from './support/iab-backend/fixture.ts';

export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);
const { PanelBrowser } = require('../electron/capabilities/browser/cdp.cjs');

const FOCUS = 'Emulation.setFocusEmulationEnabled';
const viewWC = (h: any, asView: (wc: any) => any) => asView(h.newWC({ type: 'window', prefs: { sandbox: true, contextIsolation: true } }));
const inputs = (dbg: any) => dbg.calls.filter((c: any) => c.method.startsWith('Input.'));

test('CM-K37: IAB×Claude, IAB×Codex, IAB×Switch, IAB×ACP: every input action on a view tab no window shows lands from the first event: focus is emulated before it, again after each turn end; a pane guest still asks its window to show it', async (t) => {
  const asView = viewTabs();
  const h = setup(t);
  // no window ever reports a layer for it: the tab is parked
  const tab = tabOf(h, 'tab_aaaaaa', 'c', viewWC(h, asView), null);
  const dbg = tab.wc.debugger;
  // the reported journey: the first click on a submit button, by ref or by browser_script's locator (both tabs.click)
  await drive(t, h.tabs.click(tab, { x: 172, y: 300, name: 'Add to cart' }));
  assert.deepEqual(dbg.dropped, [], 'the first click lands');
  const order = dbg.calls.map((c: any) => c.method);
  assert.ok(order.indexOf(FOCUS) >= 0 && order.indexOf(FOCUS) < order.indexOf('Input.dispatchMouseEvent'), 'focus first');
  // every other input path into the page
  await drive(t, h.tabs.hover(tab, { x: 10, y: 10 }));
  await drive(t, h.tabs.drag(tab, { x: 10, y: 10 }, { x: 50, y: 50 }));
  await drive(t, h.tabs.scroll(tab, { x: 10, y: 10 }, 'down', 2));
  await drive(t, h.tabs.wheel(tab, { x: 10, y: 10 }, 0, 120));
  await drive(t, h.tabs.typeText(tab, 'abc'));
  await drive(t, h.tabs.keys(tab, 'Enter'));
  const kinds = new Set(inputs(dbg).map((c: any) => `${c.method}:${c.params.type ?? ''}`));
  for (const k of ['Input.dispatchMouseEvent:mouseWheel', 'Input.dispatchKeyEvent:keyDown', 'Input.insertText:'])
    assert.ok(kinds.has(k), `${k} was sent`);
  assert.deepEqual(dbg.dropped, []);
  assert.deepEqual(
    dbg.sent(FOCUS).map((c: any) => c.params),
    [{ enabled: true }],
    'once per CDP session',
  );
  // the turn end lets go of CDP and with it the emulation (the user's own use of the page is not emulated): the next
  // turn's first input emulates it again
  await drive(t, h.tabs.turnEnded('c'));
  assert.equal(dbg.focus, false);
  await drive(t, h.tabs.click(tab, { x: 172, y: 300 }));
  assert.deepEqual(dbg.dropped, []);
  assert.equal(dbg.sent(FOCUS).length, 2);
  // a pane <webview> guest (views off) is shown by its window before input (paint), never emulated: emulating it
  // would make a guest the pane doesn't lay out look visible to its page and take input at no size
  const guest = tabOf(h, 'tab_bbbbbb', 'c', h.newWC(), 'front');
  await drive(t, h.tabs.click(guest, { x: 10, y: 10 }));
  assert.equal(guest.wc.debugger.sent(FOCUS).length, 0);
});

test("CM-K38: IAB×Codex: the native Codex Browser plugin's raw input reaches a parked view: its backend attaches the host's tab (which emulates focus) and keeps the plugin from turning that off mid-turn; a pane guest's emulation stays the plugin's", async (t) => {
  // the host's real tab under the plugin's backend
  const asView = viewTabs();
  const h = setup(t);
  const real = tabOf(h, 'tab_aaaaaa', 'c', viewWC(h, asView), null);
  await drive(t, real.attach());
  assert.equal(real.wc.debugger.focus, true, 'attaching a view for a turn emulates its focus');
  // on a view the host's tab owns focus emulation: the plugin turning it off is answered here and never reaches the page
  const { call, tab } = await withTab();
  const cmd = (method: string, commandParams: any) => call('executeCdp', { target: { tabId: 1 }, method, commandParams });
  const guestWc = tab.wc;
  tab.wc = asView(Object.assign(new EventEmitter(), guestWc, { id: 77 }));
  assert.deepEqual(await cmd(FOCUS, { enabled: false }), {});
  assert.equal(tab.sends.filter((s: any) => s[0] === FOCUS).length, 0, 'never reaches the page');
  // turning it on is harmless and passes, as does anything on a pane guest (views off), whose focus the host never emulates
  await cmd(FOCUS, { enabled: true });
  tab.wc = guestWc;
  await cmd(FOCUS, { enabled: false });
  assert.deepEqual(
    tab.sends.filter((s: any) => s[0] === FOCUS).map((s: any) => s[1]),
    [{ enabled: true }, { enabled: false }],
  );
  // the plugin's attach holds the host's tab, whose attach emulates focus before any of the plugin's input
  await call('attach', { tabId: 1 });
  assert.equal(tab.attached, 1);
  await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 });
  assert.ok(
    tab.sends.some((s: any) => s[0] === 'Input.dispatchMouseEvent'),
    'the input reached the attached tab',
  );
});

/** A view tab the older sage_browser_* tools drive (cdp.cjs), its debugger dropping input as Chromium does. */
function panelView(asView: (wc: any) => any) {
  const panelSession = { name: 'persist:browser' };
  const ui: any = { id: 1 };
  const wc: any = new EventEmitter();
  const calls: { method: string; params: any }[] = [];
  const dropped: any[] = [];
  let attached = false;
  let focus = false;
  Object.assign(wc, {
    id: 9,
    session: panelSession,
    isDestroyed: () => false,
    getType: () => 'window',
    getURL: () => 'https://shop.test/',
    getTitle: () => 'Shop',
    isLoading: () => false,
    isCrashed: () => false,
    setVisualZoomLevelLimits: () => undefined,
    getLastWebPreferences: () => ({ sandbox: true, contextIsolation: true }),
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true;
        focus = false;
      },
      sendCommand: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === FOCUS && wc.focusFails) throw new Error('Emulation is not available');
        if (method === FOCUS) focus = !!params.enabled;
        else if (method.startsWith('Input.dispatch') && !focus) dropped.push(method);
        if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
        if (method === 'Runtime.evaluate') return { result: { value: { mopilot_intent: true, none: true } } };
        return {};
      },
    },
  });
  asView(wc);
  const panel = new PanelBrowser({ appContents: () => [ui], panelSession: () => panelSession, open: () => {}, attachMs: 20 });
  panel.attach('c', wc, ui);
  return { panel, wc, calls, dropped };
}

test('CM-K39: IAB×Claude, IAB×Codex, IAB×Switch, IAB×ACP: the older sage_browser_* click and type on a parked view emulate focus before their input, so the first click and the Enter that submits land', async () => {
  const w = panelView(viewTabs());
  const panel = w.panel as any;
  // refs as a snapshot leaves them
  panel.tabs.get('c').refs.set('e1', 7);
  await panel.click('c', { ref: 'e1' });
  assert.deepEqual(w.dropped, [], 'the first click lands');
  const order = w.calls.map((c) => c.method);
  assert.ok(order.indexOf(FOCUS) >= 0 && order.indexOf(FOCUS) < order.indexOf('Input.dispatchMouseEvent'));
  await panel.type('c', { ref: 'e1' }, 'abc', true);
  assert.deepEqual(w.dropped, [], 'the Enter that submits lands');
});

test('CM-K39: a page whose focus emulation fails still gets the input tried (it may be shown): the failure is noted, never the action', async () => {
  const w = panelView(viewTabs());
  w.wc.focusFails = true;
  const panel = w.panel as any;
  panel.tabs.get('c').refs.set('e1', 7);
  await panel.click('c', { ref: 'e1' });
  assert.equal(w.calls.filter((c) => c.method === 'Input.dispatchMouseEvent').length, 3);
});
