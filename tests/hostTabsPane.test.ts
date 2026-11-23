// The browser pane with tabs of one chat on two Hosts (electron/capabilities/browser/agentTabs.cjs, package 3.4): keys name the Host, handlers reach the Host the key names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { encodeTabKey, decodeTabKey } = require('../electron/capabilities/browser/hostTabKey.cjs');

const { registerAgentTabs, tabView, chatView } = require('../electron/capabilities/browser/agentTabs.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');

const view = (id: string, o: any = {}) => ({ id, chatId: 'c', kind: 'tab', legacy: false, held: false, url: 'https://a.test/', ...o });

/** A Host's tabs as the pane handlers see them: what they were asked, recorded. */
function paneTabs(hostName: string, chats: string[], tabs: any[]) {
  const calls: any[][] = [];
  return {
    calls,
    chats: new Map(chats.map((c) => [c, {}])),
    list: (c: string) => tabs.filter((x) => x.chatId === c),
    takeOver: (...a: any[]) => (calls.push([hostName, 'takeOver', ...a]), true),
    signinDone: async (...a: any[]) => (calls.push([hostName, 'signinDone', ...a]), true),
    endHandoffs: (...a: any[]) => void calls.push([hostName, 'endHandoffs', ...a]),
    paneHidden: (c: string) => void calls.push([hostName, 'paneHidden', c]),
  };
}

function pane(hosts: Record<string, any>) {
  const handlers = new Map<string, Function>();
  const router = { entries: () => Object.entries(hosts), existing: (id: string) => hosts[id] ?? null };
  const sent: any[] = [];
  const stopped: string[] = [];
  const later: Function[] = [];
  const at = registerAgentTabs({
    ipcMain: { handle: (ch: string, fn: Function) => handlers.set(ch, fn) },
    tabs: () => hosts.local,
    hosts: () => router,
    grants: () => new OriginGrants({ ask: async () => null, anchor: () => 'ask' }),
    broadcast: (ch: string, payload: any) => sent.push([ch, payload]),
    stop: async (c: string) => void stopped.push(c),
    defer: (fn: Function) => later.push(fn),
  });
  return { at, later, call: (ch: string, ...a: any[]) => handlers.get(ch)!({}, ...a), sent, stopped };
}

test('I2: the pane lists a chat’s tabs on both Hosts under keys that name the Host, and Take over reaches the Host the key names', async () => {
  const local = paneTabs('local', ['c'], [view('tab_same')]);
  const h1 = paneTabs('h1', ['c'], [view('tab_same')]);
  const h2 = paneTabs('h2', ['c', 'd'], [view('tab_other'), view('tab_d', { chatId: 'd' })]);
  const p = pane({ local, h1, h2 });
  const snap = p.call('browser:agentTabs');
  assert.deepEqual(
    snap.c.map((v: any) => [v.hostId, v.tabKey]),
    [
      [undefined, 'tab_same'],
      ['h1', encodeTabKey('h1', 'tab_same')],
      ['h2', encodeTabKey('h2', 'tab_other')],
    ],
  );
  assert.deepEqual(Object.keys(snap).sort(), ['c', 'd']);
  // the same tab id on three Hosts is three different tabs: each key reaches its own
  assert.equal(p.call('browser:takeOver', 'c', encodeTabKey('h1', 'tab_same'), true), true);
  assert.equal(p.call('browser:takeOver', 'c', 'tab_same', false), true);
  assert.deepEqual(
    [...local.calls, ...h1.calls, ...h2.calls],
    [
      ['local', 'takeOver', 'c', 'tab_same', false],
      ['h1', 'takeOver', 'c', 'tab_same', true],
    ],
  );
  // a key for a Host with no tabs names nothing
  assert.equal(p.call('browser:takeOver', 'c', encodeTabKey('h9', 'tab_same'), true), false);
  assert.equal(await p.call('browser:signinDone', 'c', encodeTabKey('h2', 'tab_other'), true), true);
  assert.equal(await p.call('browser:signinDone', 'c', encodeTabKey('h9', 'tab_other'), true), false);
  assert.deepEqual(h2.calls, [['h2', 'signinDone', 'c', 'tab_other', true]]);
  // Stop and a hidden pane reach every Host the chat has tabs on
  assert.equal(await p.call('browser:stopAgent', 'c'), true);
  assert.deepEqual(p.stopped, ['c']);
  for (const h of [local, h1, h2])
    assert.equal(
      h.calls.some((c) => c[1] === 'endHandoffs'),
      true,
    );
  assert.equal(p.call('browser:paneHidden', ['c']), true);
  for (const h of [local, h1, h2])
    assert.equal(
      h.calls.some((c) => c[1] === 'paneHidden'),
      true,
    );
  assert.equal(p.call('browser:paneHidden', 'c'), false);
  // a change pushes the chat's tabs of every Host
  p.at.changed('c');
  p.later.shift()!();
  assert.equal(p.sent.at(-1)[1].tabs.length, 3);
});

test('the pane view names the Host of a tab on another Host and leaves a tab here as it was', () => {
  const grants = new OriginGrants({ ask: async () => null, anchor: () => 'ask' });
  assert.equal('hostId' in tabView(view('tab_a'), grants), false);
  assert.equal(tabView(view('tab_a'), grants).tabKey, 'tab_a');
  assert.equal(tabView(view('tab_a', { legacy: true }), grants).tabKey, null);
  const remote = tabView(view('tab_a'), grants, 'h1');
  assert.equal(remote.hostId, 'h1');
  assert.deepEqual(decodeTabKey(remote.tabKey), { hostId: 'h1', tabKey: 'tab_a' });
  assert.equal(chatView(paneTabs('h1', ['c'], [view('tab_a'), view('p', { kind: 'popup' })]), grants, 'c', 'h1').length, 1);
});

test('a pane without Host routing shows this Mac’s tabs alone and refuses a key for another Host', async () => {
  const local = paneTabs('local', ['c'], [view('tab_a')]);
  const handlers = new Map<string, Function>();
  registerAgentTabs({
    ipcMain: { handle: (ch: string, fn: Function) => handlers.set(ch, fn) },
    tabs: () => local,
    grants: () => new OriginGrants({ ask: async () => null, anchor: () => 'ask' }),
    broadcast: () => undefined,
    stop: async () => undefined,
  });
  const call = (ch: string, ...a: any[]) => handlers.get(ch)!({}, ...a);
  assert.equal(call('browser:agentTabs').c.length, 1);
  assert.equal(call('browser:takeOver', 'c', 'tab_a', true), true);
  assert.equal(call('browser:takeOver', 'c', encodeTabKey('h1', 'tab_a'), true), false);
  // before main has the tabs there is nothing to show
  const none = new Map<string, Function>();
  registerAgentTabs({
    ipcMain: { handle: (ch: string, fn: Function) => none.set(ch, fn) },
    tabs: () => null,
    grants: () => null,
    broadcast: () => undefined,
    stop: async () => undefined,
  });
  assert.deepEqual(none.get('browser:agentTabs')!({}), {});
});
