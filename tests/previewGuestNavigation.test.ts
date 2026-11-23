// Legacy user navigation interrupts pending managed/native preview loads before the new page action runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, tabOf } from './support/browser-host-kit.ts';
import { withTab } from './support/iab-backend/fixture.ts';
import { deferred, tick } from './support/async-scenarios.ts';
const require = createRequire(import.meta.url);
const { registerPaneNavigation } = require('../electron/capabilities/browser/paneNavigation.cjs');
const url = 'http://127.0.0.1:4317/';

function guestNavigation(wc: any) {
  const handlers = new Map<string, Function>();
  registerPaneNavigation({ handle: (name: string, fn: Function) => handlers.set(name, fn) }, { page: () => wc });
  return (action: string, address?: string) => {
    const handler = handlers.get('browser:navigateGuest');
    assert.ok(handler, 'legacy navigation must enter the main-process interruption owner');
    return handler({ sender: {} }, wc.id, action, address);
  };
}

test('legacy navigation validates the requested action and address before interrupting a page', () => {
  const calls: any[] = [];
  const nav = guestNavigation({ emit: (...a: any[]) => calls.push(a), loadURL: (url: string) => calls.push(url) });
  assert.throws(() => nav('delete'), /not available/);
  assert.throws(() => nav('loadURL', 'file:///private/file'), /http and https/);
  assert.throws(() => nav('loadURL'), /http and https/);
  assert.deepEqual(calls, []);
  nav('loadURL', 'about:blank');
  assert.equal(calls.at(-1), 'about:blank');
});

for (const action of ['loadURL', 'goBack', 'goForward', 'reload', 'reloadIgnoringCache']) {
  test(`legacy ${action} retires a pending managed preview navigation`, async (t) => {
    const h = setup(t),
      tab = tabOf(h),
      ready = deferred<string>();
    h.tabs.o.prepare = () => ready.promise;
    const actions: string[] = [];
    tab.wc.loadURL = (url: string) => actions.push(url);
    tab.wc.reload = () => actions.push('reload');
    tab.wc.reloadIgnoringCache = () => actions.push('reloadIgnoringCache');
    tab.wc.navigationHistory = { goBack: () => actions.push('goBack'), goForward: () => actions.push('goForward') };
    const pending = h.tabs.navigate(tab, url);
    const refused = assert.rejects(pending, { code: 'interrupted' });
    guestNavigation(tab.wc)(action, 'https://newer.test/');
    await refused;
    ready.resolve(url);
    await tick();
    assert.deepEqual(actions, [action === 'loadURL' ? 'https://newer.test/' : action]);
    assert.equal(tab.wc.debugger.sent('Page.navigate').length, 0, 'the old preview cannot replace the newer user page');
  });

  test(`legacy ${action} retires a pending native preview navigation`, async () => {
    const { call, tab, host } = await withTab();
    const ready = deferred<string>();
    host.o.prepare = () => ready.promise;
    const wc = tab.backend;
    wc.loadURL = () => {};
    wc.reload = () => {};
    wc.reloadIgnoringCache = () => {};
    wc.navigationHistory = { goBack() {}, goForward() {} };
    const pending = call('executeCdp', { target: { tabId: 1 }, method: 'Page.navigate', commandParams: { url } });
    const refused = assert.rejects(pending, { code: 'interrupted' });
    await tick();
    guestNavigation(wc)(action, 'https://newer.test/');
    await refused;
    ready.resolve(url);
    await tick();
    assert.equal(tab.sends.filter((s: any) => s[0] === 'Page.navigate').length, 0);
  });
}

test('native preview navigation checks existing takeover before preparing any process', async () => {
  const { call, tab, host } = await withTab();
  let prepared = 0;
  host.o.prepare = async () => {
    prepared++;
    return url;
  };
  tab.takenOver = true;
  await assert.rejects(call('executeCdp', { target: { tabId: 1 }, method: 'Page.navigate', commandParams: { url } }), /took over/);
  assert.equal(prepared, 0);
});
