// How main wires the browser memory guard: it starts with the built-in browser, watches every page BrowserWindows tracks
// (pane views, guests, popups) against the app windows' own processes, and stops when the app quits.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, unloadMain, flush } from './support/electron-main-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());

test('the memory guard starts with the browser, sees its pages and the app windows, and stops at quit', async () => {
  const h = await loadMain({
    before: (h) => {
      h.mods['electron/capabilities/browser/hostTools.cjs'] = { registerBrowserTools: mock.fn(), inAppBrowserEnabled: mock.fn(() => true) };
    },
  });
  await h.ready();
  await flush();
  const g = h.one('MemoryGuard');
  assert.equal(g.start.mock.callCount(), 1);
  const page = h.wc();
  page.session = h.electron.session.fromPartition('persist:browser');
  h.one('PaneViews').opts.onCreated(page);
  assert.ok(g.opts.pages().includes(page));
  // a run that is no smoke launch has no one to tell whether the worker is ready
  g.opts.onReady(null);
  // a page the guard stopped goes to BrowserWindows, which gives its crash notice the memory reason
  g.opts.onStopped(page);
  page.emit('render-process-gone', {}, { reason: 'killed' });
  const events = h.windows[0].webContents.sent.filter((m: any[]) => m[0] === 'browser:event');
  assert.equal(events.at(-1)[1].message, 'stopped for memory');
  const own = g.opts.appContents();
  assert.ok(own.length > 0);
  assert.ok(own.every((wc: any) => h.windows.some((w: any) => w.webContents === wc)));
  h.windows[0].destroyed = true;
  assert.ok(!g.opts.appContents().includes(h.windows[0].webContents));
  h.app.emit('will-quit');
  assert.equal(g.stop.mock.callCount(), 1);
});
