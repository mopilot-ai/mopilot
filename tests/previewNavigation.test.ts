// Browser tool and native-plugin navigation both restore owned previews before dispatching a page request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drive, setup, tabOf } from './support/browser-host-kit.ts';
import { withTab } from './support/iab-backend/fixture.ts';
import { deferred, tick } from './support/async-scenarios.ts';
const oldUrl = 'http://127.0.0.1:4317/';
const newUrl = 'http://127.0.0.1:4318/';

test('browser tools wait for restoration, then navigate the actual ready URL', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const ready = deferred<string>();
  const asked: any[] = [];
  h.tabs.o.prepare = (chat: string, url: string) => {
    asked.push([chat, url]);
    return ready.promise;
  };
  const pending = h.tabs.navigate(tab, oldUrl);
  assert.deepEqual(asked, [['c', oldUrl]]);
  assert.equal(tab.wc.debugger.sent('Page.navigate').length, 0);
  ready.resolve(newUrl);
  await drive(t, pending);
  assert.equal(tab.wc.debugger.sent('Page.navigate').at(-1).params.url, newUrl);
});

test('browser tools dispatch no page request after restoration fails or the tab closes', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  h.tabs.o.prepare = async () => {
    throw new Error('preview could not restart');
  };
  await assert.rejects(h.tabs.navigate(tab, oldUrl), /could not restart/);
  const ready = deferred<string>();
  h.tabs.o.prepare = () => ready.promise;
  const pending = h.tabs.navigate(tab, oldUrl);
  tab.wc.destroy();
  ready.resolve(newUrl);
  await assert.rejects(pending, /closed/);
  assert.equal(tab.wc.debugger.sent('Page.navigate').length, 0);
});

test('native Codex gates and opens the ready preview URL without mutating the plugin request', async () => {
  const { call, tab, host, grants } = await withTab();
  const ready = deferred<string>();
  const requests: any[] = [];
  host.o.prepare = (chat: string, url: string) => {
    requests.push([chat, url]);
    return ready.promise;
  };
  const args = { target: { tabId: 1 }, method: 'Page.navigate', commandParams: { url: oldUrl } };
  const pending = call('executeCdp', args);
  await tick();
  assert.equal(tab.sends.filter((s: any) => s[0] === 'Page.navigate').length, 0);
  ready.resolve(newUrl);
  await pending;
  assert.deepEqual(requests, [['chat:thread-1', oldUrl]]);
  assert.deepEqual(tab.sends.at(-1), ['Page.navigate', { url: newUrl }, '']);
  assert.ok(grants.calls.some((c: any) => c[1] === newUrl));
  assert.equal(args.commandParams.url, oldUrl);
});

test('native Codex yields to takeover during preview startup and propagates a failed restore', async () => {
  const { call, tab, host } = await withTab();
  const ready = deferred<string>();
  host.o.prepare = () => ready.promise;
  const go = () => call('executeCdp', { target: { tabId: 1 }, method: 'Page.navigate', commandParams: { url: oldUrl } });
  const pending = go();
  await tick();
  tab.takenOver = true;
  ready.resolve(newUrl);
  await assert.rejects(pending, /took over/);
  tab.takenOver = false;
  host.o.prepare = async () => {
    throw new Error('preview could not restart');
  };
  await assert.rejects(go(), /could not restart/);
  assert.equal(tab.sends.filter((s: any) => s[0] === 'Page.navigate').length, 0);
});

test('toolbar Stop during browser-tool preview startup prevents the later navigation and permits retry', async (t) => {
  const { createRequire } = await import('node:module');
  const { stopLoading } = createRequire(import.meta.url)('../electron/capabilities/browser/loadInterruption.cjs');
  const h = setup(t),
    tab = tabOf(h),
    ready = deferred<string>();
  h.tabs.o.prepare = () => ready.promise;
  const pending = h.tabs.navigate(tab, oldUrl);
  const stopped = assert.rejects(pending, { code: 'interrupted' });
  stopLoading(tab.backend);
  await stopped;
  ready.resolve(newUrl);
  await Promise.resolve();
  assert.equal(tab.wc.debugger.sent('Page.navigate').length, 0);
  h.tabs.o.prepare = async () => newUrl;
  await drive(t, h.tabs.navigate(tab, oldUrl));
  assert.equal(tab.wc.debugger.sent('Page.navigate').length, 1);
});

test('native toolbar Stop during preview startup and while the ready request queues prevents dispatch', async () => {
  const { createRequire } = await import('node:module');
  const { stopLoading } = createRequire(import.meta.url)('../electron/capabilities/browser/loadInterruption.cjs');
  for (const queued of [false, true]) {
    const { b, call, tab, host } = await withTab();
    const ready = deferred<string>();
    host.o.prepare = () => ready.promise;
    const pending = call('executeCdp', { target: { tabId: 1 }, method: 'Page.navigate', commandParams: { url: oldUrl } });
    const stopped = assert.rejects(pending, { code: 'interrupted' });
    await tick();
    let release: (() => void) | undefined;
    if (queued) {
      const blocker = deferred<void>();
      release = () => blocker.resolve();
      b.hold = () => blocker.promise;
      ready.resolve(newUrl);
      await tick();
    }
    stopLoading(tab.backend);
    await stopped;
    ready.resolve(newUrl);
    release?.();
    await tick();
    assert.equal(tab.sends.filter((s: any) => s[0] === 'Page.navigate').length, 0);
  }
});
