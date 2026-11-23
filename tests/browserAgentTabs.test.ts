// What the browser pane shows about agent control (electron/capabilities/browser/agentTabs.cjs): the
// per-tab view with its site access and sign-in hand-off, the coalesced pushes, the snapshot and the IPC
// handlers (Take over / Hand back, Stop, pane hidden, Done, continue).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerAgentTabs, siteAccess, tabView, chatView } = require('../electron/capabilities/browser/agentTabs.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');

const grants = (anchor = 'ask') => new OriginGrants({ ask: async () => null, anchor: () => anchor });

test('siteAccess: the permission the bar shows, from Full access down to ask, and null for blank pages or failures', async () => {
  assert.equal(siteAccess(null, 'https://a.test/', 'c'), null);
  assert.equal(siteAccess(grants(), 'about:blank', 'c'), null);
  assert.equal(siteAccess(grants(), 'chrome://settings', 'c'), null);
  assert.equal(siteAccess(grants('full'), 'https://a.test/x', 'c'), 'full');
  const g = grants();
  assert.equal(siteAccess(g, 'https://a.test/x', 'c'), 'ask');
  g.grants.set('https://a.test', 'write');
  assert.equal(siteAccess(g, 'https://a.test/x', 'c'), 'write');
  g.grants.set('https://a.test', 'read');
  assert.equal(siteAccess(g, 'https://a.test/x', 'c'), 'read');
  g.grants.delete('https://a.test');
  g.denied.set('c', new Set(['https://a.test']));
  assert.equal(siteAccess(g, 'https://a.test/x', 'c'), 'denied');
  assert.equal(siteAccess(g, 'https://a.test/x', 'other'), 'ask', 'a denial is per chat');
  // a read-only chat: write is read_only, read follows the grants
  const ro = grants('readOnly');
  assert.equal(siteAccess(ro, 'https://a.test/', 'c'), 'ask');
  ro.grants.set('https://a.test', 'read');
  assert.equal(siteAccess(ro, 'https://a.test/', 'c'), 'read');
  // denied for write only (stubbed grants), and a grants object without anchor()
  assert.equal(siteAccess({ peek: (_u: string, need: string) => (need === 'write' ? 'denied' : 'ok') }, 'https://a.test/', 'c'), 'denied');
  assert.equal(siteAccess({ peek: (_u: string, need: string) => (need === 'write' ? 'ask' : 'denied') }, 'https://a.test/', 'c'), 'denied');
  assert.equal(
    siteAccess(
      {
        peek: () => {
          throw new Error('boom');
        },
      },
      'https://a.test/',
      'c',
    ),
    null,
  );
  // a blocked page (a cloud metadata endpoint) is as unusable as a denied one
  assert.equal(siteAccess(grants('full'), 'http://169.254.169.254/latest/', 'c'), 'denied');
  assert.equal(siteAccess(grants('full'), 'https://www.chase.com/', 'c'), 'ask', 'Full access does not cover a high-risk site');
  assert.equal(siteAccess(grants(), 'http://169.254.169.254/latest/', 'c'), 'denied');
});

const tab = (o: any = {}) => ({
  id: 'tab_aaaaaa',
  chatId: 'c',
  kind: 'tab',
  legacy: false,
  held: false,
  created: false,
  mark: null,
  takenOver: false,
  url: 'https://a.test/p',
  ...o,
});

test('tabView and chatView: the pane sees its own tabs (not popups) with their key, state and site', () => {
  const g = grants();
  assert.deepEqual(tabView(tab({ held: 1, created: 1, mark: 'handoff', takenOver: 1, result: 1 }), g), {
    tabId: 'tab_aaaaaa',
    tabKey: 'tab_aaaaaa',
    kind: 'tab',
    active: true,
    created: true,
    mark: 'handoff',
    takenOver: true,
    result: true,
    origin: 'https://a.test',
    access: 'ask',
    signin: null,
    moved: false,
    device: null,
  });
  assert.deepEqual(tabView(tab({ legacy: true, url: '' }), g), {
    tabId: 'tab_aaaaaa',
    tabKey: null,
    kind: 'tab',
    active: false,
    created: false,
    mark: null,
    takenOver: false,
    result: false,
    origin: null,
    access: null,
    signin: null,
    moved: false,
    device: null,
  });
  // a tab handed to the user says so, with the reason and whether its page asks for a credential (never the hold's internals)
  assert.deepEqual(tabView(tab({ signin: { reason: 'GitHub', since: 1, credential: true, site: 'a.test' } }), g).signin, {
    reason: 'GitHub',
    credential: true,
  });
  assert.deepEqual(tabView(tab({ signin: { reason: '', since: 1, site: 'a.test' } }), g).signin, { reason: '', credential: false });
  // the user took the hand-off to their Chrome: their turn is there
  assert.equal(tabView(tab({ signinMoved: 'The user moved this sign-in to their Chrome' }), g).moved, true);
  // the device the agent emulates (browser_resize_window): a preset by name, a custom size by its size
  assert.deepEqual(tabView(tab({ emulated: { preset: 'mobile', w: 375, h: 812, dpr: 3, mobile: true, touch: true } }), g).device, {
    preset: 'mobile',
    label: 'Mobile',
    width: 375,
    height: 812,
  });
  assert.deepEqual(tabView(tab({ emulated: { preset: null, w: 1280, h: 720, dpr: 0, mobile: false, touch: false } }), g).device, {
    preset: null,
    label: '1280×720',
    width: 1280,
    height: 720,
  });
  const tabs = { list: (chatId: string) => (chatId === 'c' ? [tab(), tab({ id: 'tab_bbbbbb', kind: 'popup' })] : []) };
  assert.deepEqual(
    chatView(tabs, g, 'c').map((t: any) => t.tabId),
    ['tab_aaaaaa'],
  );
  assert.deepEqual(chatView(tabs, g, 'x'), []);
});

function ipc() {
  const handlers = new Map<string, Function>();
  return {
    handlers,
    ipcMain: { handle: (ch: string, fn: Function) => handlers.set(ch, fn) },
    call: (ch: string, ...a: any[]) => handlers.get(ch)!({}, ...a),
  };
}

test('registerAgentTabs: changes are coalesced per chat and broadcast with the chat view', () => {
  const { ipcMain } = ipc();
  const deferred: Function[] = [];
  const sent: any[] = [];
  let tabs: any = {
    chats: new Map([
      ['c', {}],
      ['d', {}],
      ['empty', {}],
    ]),
    list: (chatId: string) => (chatId === 'empty' ? [] : [tab({ chatId })]),
  };
  const at = registerAgentTabs({
    ipcMain,
    tabs: () => tabs,
    grants: () => grants(),
    broadcast: (ch: string, p: any) => sent.push([ch, p]),
    stop: () => {},
    defer: (fn: Function) => deferred.push(fn),
  });
  at.changed('c');
  at.changed('c');
  at.changed('d');
  at.changed('');
  at.changed(42 as any);
  assert.equal(deferred.length, 1, 'one flush for a burst');
  deferred.shift()!();
  assert.deepEqual(
    sent.map(([ch, p]) => [ch, p.chatId, p.tabs.length]),
    [
      ['browser:agentTabsChanged', 'c', 1],
      ['browser:agentTabsChanged', 'd', 1],
    ],
  );
  // the snapshot leaves out chats with nothing to show
  assert.deepEqual(Object.keys(at.snapshot()), ['c', 'd']);
  // no browser host yet: nothing is sent and the snapshot is empty
  tabs = null;
  at.changed('c');
  deferred.shift()!();
  assert.equal(sent.length, 2);
  assert.deepEqual(at.snapshot(), {});
});

test('registerAgentTabs: the default defer is setImmediate', async () => {
  const { ipcMain } = ipc();
  const sent: any[] = [];
  const at = registerAgentTabs({
    ipcMain,
    tabs: () => ({ chats: new Map(), list: () => [] }),
    grants: () => null,
    broadcast: (ch: string, p: any) => sent.push(p),
    stop: () => {},
  });
  at.changed('c');
  assert.equal(sent.length, 0);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [{ chatId: 'c', tabs: [] }]);
});

test('registerAgentTabs IPC: snapshot, Take over / Hand back, Stop and pane hidden validate their arguments', async () => {
  const { ipcMain, call } = ipc();
  const calls: any[] = [];
  let host: any = {
    chats: new Map([['c', {}]]),
    list: () => [tab()],
    takeOver: (...a: any[]) => (calls.push(['takeOver', ...a]), a[1] !== 'tab_gone'),
    paneHidden: (id: string) => calls.push(['paneHidden', id]),
    signinDone: async (...a: any[]) => (calls.push(['signinDone', ...a]), a[1] !== 'tab_none'),
    endHandoffs: (...a: any[]) => calls.push(['endHandoffs', ...a]),
  };
  const stopped: string[] = [];
  registerAgentTabs({
    ipcMain,
    tabs: () => host,
    grants: () => grants(),
    broadcast: () => {},
    stop: async (id: string) => {
      stopped.push(id);
    },
    defer: () => {},
  });

  assert.deepEqual(Object.keys(call('browser:agentTabs')), ['c']);
  assert.equal(call('browser:takeOver', 'c', 'tab_aaaaaa'), true);
  assert.equal(call('browser:takeOver', 'c', 'tab_aaaaaa', false), true);
  assert.equal(call('browser:takeOver', 'c', null, undefined), true);
  assert.equal(call('browser:takeOver', 'c', 7, true), true);
  assert.equal(call('browser:takeOver', 'c', 'tab_gone'), false);
  assert.equal(call('browser:takeOver', '', 'tab_aaaaaa'), false);
  assert.equal(call('browser:takeOver', 5, 'tab_aaaaaa'), false);
  assert.deepEqual(calls, [
    ['takeOver', 'c', 'tab_aaaaaa', true],
    ['takeOver', 'c', 'tab_aaaaaa', false],
    ['takeOver', 'c', null, true],
    ['takeOver', 'c', null, true],
    ['takeOver', 'c', 'tab_gone', true],
  ]);

  assert.equal(await call('browser:stopAgent', 'c'), true);
  assert.equal(await call('browser:stopAgent', ''), false);
  assert.equal(await call('browser:stopAgent', null), false);
  assert.deepEqual(stopped, ['c']);
  // Stop ends the chat's hand-offs too, whether or not a turn runs (#1834)
  assert.deepEqual(calls.at(-1), ['endHandoffs', 'c', 'stopped']);

  calls.length = 0;
  assert.equal(call('browser:paneHidden', ['c', '', 3, 'd']), true);
  assert.deepEqual(calls, [
    ['paneHidden', 'c'],
    ['paneHidden', 'd'],
  ]);
  assert.equal(call('browser:paneHidden', 'c'), false);

  // Done, continue: a tab id (or none for the chat's held tab), done unless false
  calls.length = 0;
  assert.equal(await call('browser:signinDone', 'c', 'tab_aaaaaa'), true);
  assert.equal(await call('browser:signinDone', 'c', null, false), true);
  assert.equal(await call('browser:signinDone', 'c', '', true), true);
  assert.equal(await call('browser:signinDone', 'c', 'tab_none'), false);
  assert.equal(await call('browser:signinDone', '', 'tab_aaaaaa'), false);
  assert.deepEqual(calls, [
    ['signinDone', 'c', 'tab_aaaaaa', true],
    ['signinDone', 'c', null, false],
    ['signinDone', 'c', null, true],
    ['signinDone', 'c', 'tab_none', true],
  ]);
  host = null;
  assert.equal(call('browser:takeOver', 'c', 'tab_aaaaaa'), false);
  assert.equal(call('browser:paneHidden', ['c']), false);
  assert.equal(await call('browser:signinDone', 'c', 'tab_aaaaaa'), false);
  assert.equal(await call('browser:stopAgent', 'c'), true, 'Stop still stops the turn with no browser host');
});
