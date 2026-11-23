// The control matrix (docs/control-plane/matrix.md), stream Z: input on a chat's tab in the user's Chrome, which is a background tab.
// Chrome keeps a background tab hidden: it draws no frames, so CDP input to it hangs (a mouse move waits about five
// seconds for its answer), lands on nothing (the first click does nothing), and is never routed into a cross-site
// iframe. The browser host over Chrome (chromeHost.cjs) emulates focus on each tab it attaches to, as the Codex
// Browser plugin does, so the page is visible and focused to itself and takes input where it lands. The host is
// the same for every harness (the chrome_* tools, the browser_* tools and the Codex backend all run on it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { setup, tabOf, drive } from './support/browser-host-kit.ts';

export const GUARDS = ['electron/capabilities/', 'shared/'];

const require = createRequire(import.meta.url);
const { chromeBrowserTabs } = require('../electron/capabilities/browser/chromeHost.cjs');

const FOCUS = 'Emulation.setFocusEmulationEnabled';

test("CM-Z22: a chat's tab in the user's Chrome takes input in the background: its CDP session emulates focus from the first attach, again after each turn end, and before any input", async (t) => {
  // the Chrome host is a host whose pages take input in the background
  const relay: any = Object.assign(new EventEmitter(), { advance: () => undefined });
  assert.equal(chromeBrowserTabs({ relay, images: { fromBuffer: () => null } }).o.inputWhileHidden, true);
  const h = setup(t, { inputWhileHidden: true });
  const tab = tabOf(h, 'tab_aaaaaa', 'c', h.newWC(), null);
  const dbg = tab.wc.debugger;
  await drive(t, h.tabs.click(tab, { x: 10, y: 10 }));
  assert.deepEqual(
    dbg.sent(FOCUS).map((c: any) => c.params),
    [{ enabled: true }],
  );
  const order = dbg.calls.map((c: any) => c.method);
  assert.ok(order.indexOf(FOCUS) < order.indexOf('Input.dispatchMouseEvent'), 'focus is emulated before the first input');
  // the turn end lets go of CDP (and with it the emulation): the next turn's first action emulates it again
  await drive(t, h.tabs.turnEnded('c'));
  await drive(t, h.tabs.click(tab, { x: 10, y: 10 }));
  assert.equal(dbg.sent(FOCUS).length, 2);
  // a pane <webview> guest is shown by its window: it never emulates focus (a parked view does, CM-K37)
  const pane = setup(t);
  const guest = tabOf(pane);
  await drive(t, pane.tabs.click(guest, { x: 10, y: 10 }));
  assert.equal(guest.wc.debugger.sent(FOCUS).length, 0);
});

test("CM-Z23: input and screenshots on a chat's Chrome tab never wait for MoPilot's pane to lay it out (it lives in Chrome's window)", async (t) => {
  const h = setup(t, { inputWhileHidden: true });
  // no pane window ever reports a layer for a Chrome tab
  const tab = tabOf(h, 'tab_aaaaaa', 'c', h.newWC(), null);
  const before = h.log.select.length;
  const start = Date.now();
  await drive(t, h.tabs.ready(tab, 'c', { input: true }));
  assert.ok(Date.now() - start < h.tabs.showMs, `ready took ${Date.now() - start} ms`);
  assert.ok(h.log.select.length - before <= 1, 'revealed at most once, never selected to be painted');
  // the frame wait still runs: a screenshot shows the page after it drew
  assert.ok(tab.wc.debugger.sent('Runtime.evaluate').some((c: any) => /requestAnimationFrame/.test(c.params.expression)));
  // a pane tab nobody lays out is still asked to show and waited for
  const pane = setup(t);
  const guest = tabOf(pane, 'tab_aaaaaa', 'c', pane.newWC(), null);
  const t0 = Date.now();
  await drive(t, pane.tabs.ready(guest, 'c', { input: true }), { max: 4000 });
  assert.ok(Date.now() - t0 >= pane.tabs.showMs);
});
