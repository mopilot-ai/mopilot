// The production view Stop path settles current and legacy agent load waits as an interruption, using fake pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, navTab, flush, drive } from './support/browser-host-kit.ts';
import { setup as setupViews } from './support/browser-view-fixture.ts';
const require = createRequire(import.meta.url);
const { PanelBrowser } = require('../electron/capabilities/browser/cdp.cjs');
const { browserWorld } = require('./helpers/browser.cjs');
const stop = (wc: any) => {
  wc.stop = () => {
    wc.loading = false;
    wc.emit('did-stop-loading');
  };
  const { views, sender } = setupViews();
  views.entries.set(wc.id, { wc, binders: new Set() });
  views.state = () => ({});
  views.nav(wc.id, sender, 'stop');
};

test('Stop interrupts modern navigate/history/load-state/settle waits and a fresh navigation still succeeds', async (t) => {
  const h = setup(t);
  const tab = navTab(t, h);
  for (const operation of ['navigate', 'history', 'waitForLoad', 'settle']) {
    tab.wc.loading = true;
    tab.wc.handlers['Page.navigate'] = () => ({ loaderId: 'L' });
    tab.wc.ops.state = () => ({ ready: 'loading', quietMs: 0 });
    const pending =
      operation === 'navigate'
        ? h.tabs.navigate(tab, 'https://slow.test/')
        : operation === 'history'
          ? h.tabs.history(tab, 'reload')
          : operation === 'waitForLoad'
            ? h.tabs.waitForLoad(tab)
            : h.tabs.settle(tab);
    const rejected = assert.rejects(drive(t, pending), { code: 'interrupted' });
    await flush();
    stop(tab.wc);
    await rejected;
  }
  tab.wc.handlers['Page.navigate'] = () => undefined;
  tab.wc.ops.state = () => ({ ready: 'complete', quietMs: 1000 });
  await drive(t, h.tabs.navigate(tab, 'https://retry.test/'));
});

test('Stop interrupts an unanswered CDP navigation command, including the legacy panel, without leaking a later continuation', async (t) => {
  const h = setup(t);
  const tab = navTab(t, h);
  tab.wc.handlers['Page.navigate'] = () => new Promise(() => {});
  const modern = h.tabs.navigate(tab, 'https://slow.test/');
  const modernError = assert.rejects(modern, { code: 'interrupted' });
  await flush();
  stop(tab.wc);
  await modernError;
  const w = browserWorld();
  const panel = new PanelBrowser({ ...w, open: () => false });
  panel.attach('chat', w.root, w.host);
  w.root.command = () => new Promise(() => {});
  const legacy = panel.navigate('chat', 'https://slow.test/');
  const legacyError = assert.rejects(legacy, { code: 'interrupted' });
  await flush();
  stop(w.root);
  await legacyError;
});

test('Stop during a legacy completed-command load remains distinct from a real failure or a later retry', async () => {
  const w = browserWorld();
  const panel = new PanelBrowser({ ...w, open: () => false });
  panel.attach('chat', w.root, w.host);
  w.root.command = () => ({ loaderId: 'L' });
  const pending = panel.navigate('chat', 'https://slow.test/');
  const rejected = assert.rejects(pending, { code: 'interrupted' });
  await flush();
  stop(w.root);
  await rejected;
  w.root.command = () => ({ errorText: 'ERR_NAME_NOT_RESOLVED' });
  await assert.rejects(panel.navigate('chat', 'https://bad.test/'), { code: 'failed' });
  w.root.command = () => undefined;
  assert.ok(await panel.navigate('chat', 'https://retry.test/'));
});
