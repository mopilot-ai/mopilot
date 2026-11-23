// Real browser tools and ChromeBackend reject restored stale identities, re-list fresh ones, and retain ordinary site grants without sockets.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { world } from './support/chrome-membership-kit.mjs';

export const GUARDS = ['electron/capabilities/', 'electron/chrome-extension/', 'shared/'];

const require = createRequire(import.meta.url);
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { ChromeBackend } = require('../electron/capabilities/browser/chromeBackend.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const ALLOWED = 'https://allowed.example';
const BLOCKED = 'https://blocked.example';

function setup(t: any) {
  const w = world();
  t.after(() => w.tabs.dispose());
  const asked: any[] = [];
  const grants = new OriginGrants({
    browser: 'chrome',
    ask: async (request: any) => {
      asked.push(request);
      return { decision: 'deny' };
    },
  });
  const allowed = new Map([[ALLOWED, 'write']]);
  const denied = new Set([BLOCKED]);
  grants.chatGrants.set('a', allowed);
  grants.denied.set('a', denied);
  const native = (target: any) => w.chrome.tabsById.get(target.tabId);
  w.chrome.cdp['Target.getTargetInfo'] = (_p: any, target: any) => ({
    targetInfo: { targetId: `T${target.tabId}`, url: native(target).url },
  });
  w.chrome.cdp['Page.getFrameTree'] = (_p: any, target: any) => ({ frameTree: { frame: { id: `T${target.tabId}` } } });
  w.chrome.cdp['Page.getNavigationHistory'] = (_p: any, target: any) => ({
    currentIndex: 0,
    entries: [{ id: 1, url: native(target).url }],
  });
  w.chrome.cdp['Page.createIsolatedWorld'] = { executionContextId: 3 };
  w.chrome.cdp['Runtime.evaluate'] = (p: any) =>
    String(p.expression).includes('navigator.userAgent')
      ? { result: { value: 'Chrome/140' } }
      : { result: { value: { value: { quietMs: 1000, visibility: 'visible', ready: 'complete' }, seq: 0 } } };
  w.chrome.cdp['Page.navigate'] = (p: any, target: any) => {
    const source = { tabId: target.tabId };
    const frameId = `T${target.tabId}`;
    w.sessions.onDebuggerEvent(source, 'Page.frameStartedLoading', { frameId });
    native(target).url = p.url;
    w.sessions.onDebuggerEvent(source, 'Page.frameNavigated', { frame: { id: frameId, url: p.url } });
    w.sessions.onDebuggerEvent(source, 'Page.frameStoppedLoading', { frameId });
    return { frameId, loaderId: 'L1' };
  };
  const navigations = () => w.chrome.log.filter(([name, , method]) => name === 'debugger.sendCommand' && method === 'Page.navigate');
  const created = () => w.chrome.log.filter(([name]) => name === 'tabs.create').length;
  const suspend = () => {
    const link = w.relay.link('a');
    link.resumable = true;
    link.close('connection dropped');
  };
  const stableReconnectThenRestart = async (first: any) => {
    const receipt = first.wc.membership;
    await w.sessions.saveTail;
    suspend();
    await w.relay.connect('a');
    assert.equal(w.tabs.list('a')[0], first, 'ordinary network reconnect preserves the existing wrapper');
    assert.equal(first.wc.membership, receipt);
    await w.sessions.saveTail;
    suspend();
    await w.restart();
    await w.sessions.saveTail;
    assert.notEqual(w.sessions.memberships.get(first.wc.tabId)!.id, receipt, 'worker restore changes authority');
  };
  const checkGrants = () => {
    assert.equal(grants.chatGrants.get('a'), allowed);
    assert.equal(grants.denied.get('a'), denied);
    assert.equal(grants.peek(`${ALLOWED}/retry`, 'write', { chatId: 'a', segmentId: 'thread' }), 'ok');
    assert.equal(asked.length, 0, 'existing ordinary grants and denials need no new permission card');
  };
  return { w, grants, navigations, created, stableReconnectThenRestart, checkGrants };
}

test('browser tools cancel the old restored request and re-list/retry with a fresh host identity on the same physical tab', async (t) => {
  const { w, grants, navigations, created, stableReconnectThenRestart, checkGrants } = setup(t);
  const tools = new Map<string, any>(createBrowserTools({ tabs: w.tabs, grants }).map((tool: any) => [tool.name, tool]));
  const ctx = { chatId: 'a', segmentId: 'thread' };
  const first = await w.tabs.create('a');
  const nativeId = first.wc.tabId;
  first.wc.url = w.chrome.tabsById.get(nativeId).url = `${ALLOWED}/before`;
  const before = created();
  await stableReconnectThenRestart(first);
  const url = `${ALLOWED}/retry`;
  const navigate = (tabId: string, destination: string) => tools.get('browser_navigate').handler({ tabId, url: destination }, ctx);
  await assert.rejects(navigate(first.id, url), { code: 'tab_closed' });
  assert.equal(navigations().length, 0, 'retired request never reaches Chrome');
  const listed = await tools.get('browser_tabs_context').handler({}, ctx);
  const fresh = w.tabs.list('a')[0];
  assert.ok(listed[0].text.includes(fresh.id));
  assert.notEqual(fresh, first);
  assert.notEqual(fresh.id, first.id);
  assert.equal(fresh.wc.tabId, nativeId);
  assert.equal(first.wc.isDestroyed(), true);
  assert.equal(fresh.created, false);
  assert.equal(fresh.owner, null);
  await assert.rejects(navigate(fresh.id, `${BLOCKED}/never`), /denied|declined|blocked|did not allow/i);
  assert.equal(navigations().length, 0, 'fresh identity does not bypass the existing site denial');
  const result = await navigate(fresh.id, url);
  assert.ok(result[0].text.startsWith(`Navigated ${fresh.id} to ${url}`));
  assert.deepEqual(
    navigations().map(([, target, , params]) => [target.tabId, params.url]),
    [[nativeId, url]],
  );
  assert.equal(created(), before);
  checkGrants();
});

test('ChromeBackend retires the old backend ID and re-lists a fresh permitted identity for the same physical tab', async (t) => {
  const { w, grants, navigations, created, stableReconnectThenRestart, checkGrants } = setup(t);
  const backend = new ChromeBackend({ threadId: 'thread', chatOf: () => 'a', tabs: () => w.tabs, grants: () => grants });
  const original = await backend.handle('createTab', { session_id: 'thread' });
  const first = w.tabs.list('a')[0];
  const nativeId = first.wc.tabId;
  first.wc.url = w.chrome.tabsById.get(nativeId).url = `${ALLOWED}/before`;
  const before = created();
  await stableReconnectThenRestart(first);
  const cdp = (tabId: number, url: string) =>
    backend.handle('executeCdp', {
      session_id: 'thread',
      target: { tabId },
      method: 'Page.navigate',
      commandParams: { url },
    });
  const url = `${ALLOWED}/retry`;
  await assert.rejects(cdp(original.id, url), { code: 'tab_closed' });
  assert.equal(navigations().length, 0);
  const listed = await backend.handle('getTabs', { session_id: 'thread' });
  assert.equal(listed.length, 1);
  const fresh = listed[0];
  assert.notEqual(fresh.id, original.id);
  assert.notEqual(fresh.providerTabId, original.providerTabId);
  assert.equal(fresh.sessionControlled, false, 'backend control does not survive receipt rotation');
  assert.equal(w.tabs.list('a')[0].wc.tabId, nativeId);
  assert.equal(first.wc.isDestroyed(), true);
  await assert.rejects(cdp(original.id, url), /Unknown tab/);
  await assert.rejects(cdp(fresh.id, `${BLOCKED}/never`), /denied|declined|blocked|did not allow/i);
  assert.equal(navigations().length, 0);
  await cdp(fresh.id, url);
  assert.deepEqual(
    navigations().map(([, target, , params]) => [target.tabId, params.url]),
    [[nativeId, url]],
  );
  assert.equal(created(), before);
  checkGrants();
});
