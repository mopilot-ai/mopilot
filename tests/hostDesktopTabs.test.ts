// A Host chat's desktop as an agent tab in the pane (electron/capabilities/hostDesktopTabs.cjs, browser/agentTabs.cjs): it appears when the chat uses the desktop, is listed beside the browser tabs, is taken over and handed back like them, and while the user drives it the agent's calls wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rig } = await import('./support/computer-use-setup-rig.ts');
const { waitFor } = await import('./support/waitFor.ts');
const { createHostDesktopTabs, DESKTOP_TAB } = require('../electron/capabilities/hostDesktopTabs.cjs');
const { registerAgentTabs } = require('../electron/capabilities/browser/agentTabs.cjs');
const { decodeTabKey } = require('../electron/capabilities/browser/hostTabKey.cjs');
const { UNKNOWN_OWNER } = require('../shared/host/desktop.mjs');

function provider() {
  const changed: string[] = [];
  const opened: string[][] = [];
  const held: string[] = [];
  const tabs = createHostDesktopTabs({
    hold: (c: string) => held.push(c),
    onChange: (c: string) => changed.push(c),
    nameOf: (h: string) => `machine ${h}`,
    onOpen: (c: string, k: string) => opened.push([c, k]),
  });
  return { tabs, changed, opened, held };
}

test('a chat’s desktop tab appears once it used the desktop, is keyed by its Host, names the machine, and a repeat changes nothing', () => {
  const { tabs, changed, opened } = provider();
  assert.deepEqual(tabs.list('c1'), []);
  tabs.note('c1', 'h1', true);
  tabs.note('c1', 'h1', true);
  assert.deepEqual(changed, ['c1']);
  assert.deepEqual(opened, [['c1', JSON.stringify(['host', 'h1', 'desktop'])]], 'windows are asked to open it once');
  tabs.note('c9', 'h2', true);
  assert.equal(opened.length, 2, 'another chat opens its own');
  const [tab] = tabs.list('c1');
  assert.deepEqual(decodeTabKey(tab.tabKey), { hostId: 'h1', tabKey: DESKTOP_TAB });
  assert.deepEqual(
    { kind: tab.kind, active: tab.active, takenOver: tab.takenOver, hostId: tab.hostId, desktop: tab.desktop },
    { kind: 'tab', active: true, takenOver: false, hostId: 'h1', desktop: { machine: 'machine h1' } },
  );
  assert.deepEqual(tabs.chats(), ['c1', 'c9']);
});

test('the user takes the desktop over and hands it back; a chat with no desktop has nothing to take over; the turn ending leaves the tab but not in use', () => {
  const { tabs, changed } = provider();
  assert.equal(tabs.takeOver('nobody', true), false);
  assert.equal(tabs.takenOver('nobody'), false);
  tabs.note('c1', 'h1', true);
  changed.length = 0;
  assert.equal(tabs.takeOver('c1', true), true);
  assert.equal(tabs.takeOver('c1', true), true);
  assert.equal(tabs.takenOver('c1'), true);
  assert.deepEqual(changed, ['c1'], 'told once');
  tabs.idle('c1');
  tabs.idle('c1');
  tabs.idle('nobody');
  assert.equal(tabs.list('c1')[0].active, false);
  assert.equal(tabs.takeOver('c1', false), true);
  assert.equal(tabs.takenOver('c1'), false);
});

test('a chat that moved to another machine has that one’s tab, not taken over; a machine that went takes its tabs; a finished chat has none', () => {
  const { tabs, changed } = provider();
  tabs.note('c1', 'h1', true);
  tabs.takeOver('c1', true);
  tabs.note('c1', 'h2', true);
  assert.equal(tabs.list('c1')[0].hostId, 'h2');
  assert.equal(tabs.takenOver('c1'), false);
  tabs.note('c2', 'h1', true);
  tabs.forgetHost('h2');
  assert.deepEqual(tabs.chats(), ['c2']);
  changed.length = 0;
  tabs.forget('c2');
  tabs.forget('c2');
  assert.deepEqual(changed, ['c2']);
  assert.deepEqual(tabs.chats(), []);
});

test('the pane’s agent-tab list shows the desktop beside the browser tabs, and Take over on its key goes to the desktop, not to a browser', async () => {
  const { tabs } = provider();
  tabs.note('c1', 'h1', true);
  const handlers = new Map<string, any>();
  const browserCalls: any[] = [];
  const view = registerAgentTabs({
    ipcMain: { handle: (c: string, fn: any) => handlers.set(c, fn) },
    tabs: () => null,
    hosts: () => ({ entries: () => [], existing: () => ({ takeOver: (...a: any[]) => (browserCalls.push(a), true) }) }),
    desktops: () => tabs,
    grants: () => ({}),
    broadcast: () => undefined,
    stop: async () => undefined,
    defer: (fn: () => void) => fn(),
  });
  const snap = await handlers.get('browser:agentTabs')({});
  assert.deepEqual(Object.keys(snap), ['c1']);
  assert.equal(snap.c1[0].tabId, DESKTOP_TAB);
  const key = snap.c1[0].tabKey;
  assert.equal(await handlers.get('browser:takeOver')({}, 'c1', key, true), true);
  assert.equal(tabs.takenOver('c1'), true);
  assert.equal(await handlers.get('browser:takeOver')({}, 'c1', key, false), true);
  assert.equal(tabs.takenOver('c1'), false);
  assert.equal(await handlers.get('browser:takeOver')({}, 'nobody', key, true), false);
  assert.deepEqual(browserCalls, [], 'a browser tab was never asked');
  assert.equal(typeof view.changed, 'function');
  // without the desktops, nothing changes for a build that has none
  const plain = registerAgentTabs({
    ipcMain: { handle: (c: string, fn: any) => handlers.set(c, fn) },
    tabs: () => null,
    grants: () => ({}),
    broadcast: () => undefined,
    stop: async () => undefined,
  });
  assert.deepEqual(plain.snapshot(), {});
});

test('as the real setup builds it: using the desktop gives the chat its tab, the pane hears it, driving it makes the agent wait, handing back lets it go on, and a finished chat loses the tab', async () => {
  const log: any[] = [];
  const remote = {
    lease: async () => undefined,
    command: async (c: string, m: string, params: any = {}) => {
      log.push([c, m]);
      if (m === 'apps.resolve')
        return {
          apps: params.queries.map((q: string) => ({
            query: q,
            app: { bundleId: 'com.apple.Notes', name: 'Notes', running: true, pid: 1 },
          })),
        };
      if (m === 'screenshot')
        return {
          png: 'AAAA',
          width: 10,
          height: 10,
          pixelsPerPoint: 1,
          display: { id: 1, x: 0, y: 0, width: 10, height: 10 },
          mimeType: 'image/png',
        };
      return m === 'displays.list' ? { displays: [] } : { ok: true };
    },
    release: async () => undefined,
    abort: async () => undefined,
    state: async () => ({ available: true }),
    alive: () => true,
  };
  const heard: string[] = [];
  const r = rig({
    flags: { 'shared.computerUse.parityTools': true },
    options: {
      hostOwner: (c: string) => (c === 'lost' ? UNKNOWN_OWNER : c === 'onHost' ? 'h1' : null),
      remoteDesktopFor: (id: string) => (id === 'h1' ? remote : null),
      hostName: () => 'box',
      userIdleSeconds: async () => 1,
      desktopTabsChanged: (c: string) => heard.push(c),
    },
  });
  r.states.set('onHost', { activeTurn: { id: 't1', human: true }, permission: 'default' });
  const tabs = r.runtime.hostDesktop.tabs;
  assert.deepEqual(tabs.list('onHost'), []);
  const asked = r.registry.invoke('onHost', 's1', 'desktop_request_access', { apps: ['Notes'], reason: 'x' });
  await waitFor(() => r.approvals.length > 0, 'the access card');
  await r.ipc('computer:answer', r.approvals[0].id, { decision: 'allow', scope: 'chat' });
  await asked;
  assert.equal(tabs.list('onHost')[0].desktop.machine, 'box');
  assert.ok(heard.includes('onHost'), 'the pane is told');
  await new Promise((res) => setImmediate(res));
  assert.ok(
    r.log.some(
      (l) =>
        l[0] === 'broadcast' &&
        l[1] === 'app:command' &&
        l[2] === 'open-agent-browser-tab' &&
        l[3].chatId === 'onHost' &&
        l[3].auto === true,
    ),
    'windows are asked to open the tab',
  );
  // the user drives: the agent's call is refused with the reason, and nothing reaches the Host
  tabs.takeOver('onHost', true);
  const before = log.length;
  const refused = await r.registry.invoke('onHost', 's1', 'desktop_screenshot', {});
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'user_took_over');
  assert.match(refused.error.message, /Hand it back/);
  assert.equal(log.length, before);
  tabs.takeOver('onHost', false);
  const again = await r.registry.invoke('onHost', 's1', 'desktop_screenshot', {});
  // handed back: the agent's own rules apply again (here the policy wants a granted app in front), not the wait for the user
  assert.notEqual(again.error?.code, 'user_took_over');
  assert.ok(log.length > before, 'the call reached the Host again');
  // the turn ends: the tab stays, not in use; the chat ends: the tab goes
  r.registry.turns.retire('onHost');
  assert.equal(tabs.list('onHost')[0].active, false);
  await r.ipc('computer:forget', 'onHost');
  assert.deepEqual(tabs.list('onHost'), []);
});

test('taking over from anywhere stops the agent once; a takeover ends with the turn, even on a tab not in use, and when its machine drops; hostOf says where a chat is', () => {
  const { tabs, held, changed } = provider();
  assert.equal(tabs.hostOf('c1'), null);
  tabs.note('c1', 'h1', true);
  tabs.note('c2', 'h2', true);
  assert.equal(tabs.hostOf('c1'), 'h1');
  tabs.takeOver('c1', true);
  tabs.takeOver('c1', true);
  tabs.takeOver('c1', false);
  tabs.takeOver('c1', true);
  assert.deepEqual(held, ['c1', 'c1'], 'each takeover holds once; a hand back and repeats hold nothing');
  tabs.note('c1', 'h1', false);
  assert.equal(tabs.takenOver('c1'), true, 'a tab not in use stays taken over until the turn ends');
  changed.length = 0;
  tabs.idle('c1');
  assert.equal(tabs.takenOver('c1'), false, 'the turn ended: later turns are not refused');
  assert.deepEqual(changed, ['c1']);
  tabs.takeOver('c2', true);
  tabs.hostLost('h1');
  assert.equal(tabs.takenOver('c2'), true, 'another machine’s takeover goes on');
  tabs.hostLost('h2');
  assert.equal(tabs.takenOver('c2'), false);
  tabs.hostLost('h2');
});
