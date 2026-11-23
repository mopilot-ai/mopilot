// The pane's window onto a tab on a Host (electron/capabilities/browser/remoteView.cjs, package 2.6): frames pushed to the watching window, and the user's input forwarded only while the tab is theirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { registerRemoteView, inputCommand } = require('../electron/capabilities/browser/remoteView.cjs');
const { encodeTabKey } = require('../electron/capabilities/browser/hostTabKey.cjs');

test('B1: a mouse input becomes one CDP mouse event; anything malformed is not forwarded', () => {
  assert.deepEqual(inputCommand({ kind: 'mouse', type: 'down', x: 10, y: 20 }), {
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1, deltaX: 0, deltaY: 0, modifiers: 0 },
  });
  const up = inputCommand({ kind: 'mouse', type: 'up', x: 1, y: 2, button: 'right', clickCount: 2, modifiers: 8 });
  assert.deepEqual(
    [up.params.type, up.params.buttons, up.params.button, up.params.clickCount, up.params.modifiers],
    ['mouseReleased', 0, 'right', 2, 8],
  );
  assert.equal(inputCommand({ kind: 'mouse', type: 'move', x: 1, y: 2 }).params.type, 'mouseMoved');
  const wheel = inputCommand({ kind: 'mouse', type: 'wheel', x: 1, y: 2, deltaX: 3, deltaY: -120 });
  assert.deepEqual([wheel.params.type, wheel.params.deltaX, wheel.params.deltaY, wheel.params.buttons], ['mouseWheel', 3, -120, 0]);
  for (const bad of [
    { type: 'tap', x: 1, y: 2 },
    { type: 'down', x: '1', y: 2 },
    { type: 'down', x: 1, y: Number.NaN },
    { type: 'down', x: 1e9, y: 2 },
    { type: 'down', x: 1, y: 2, button: 'back' },
    { type: 'down', x: 1, y: 2, clickCount: 0 },
    { type: 'down', x: 1, y: 2, clickCount: 4 },
    { type: 'wheel', x: 1, y: 2, deltaX: 'a' },
    { type: 'wheel', x: 1, y: 2, deltaY: 1e9 },
    { type: 'down', x: 1, y: 2, modifiers: 16 },
    { type: 'down', x: 1, y: 2, modifiers: 1.5 },
  ])
    assert.equal(inputCommand({ kind: 'mouse', ...bad }), null, JSON.stringify(bad));
});

test('B1: a key becomes one CDP key event, typing its character with the press; text is inserted whole; the rest is not forwarded', () => {
  assert.deepEqual(inputCommand({ kind: 'key', type: 'down', key: 'a', code: 'KeyA', text: 'a', keyCode: 65, modifiers: 2 }), {
    method: 'Input.dispatchKeyEvent',
    params: { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, text: 'a' },
  });
  assert.deepEqual(inputCommand({ kind: 'key', type: 'up', key: 'a', text: 'a' }).params, {
    type: 'keyUp',
    key: 'a',
    code: '',
    windowsVirtualKeyCode: 0,
    modifiers: 0,
  });
  assert.deepEqual(inputCommand({ kind: 'key', type: 'down', key: 'Enter' }).params, {
    type: 'keyDown',
    key: 'Enter',
    code: '',
    windowsVirtualKeyCode: 0,
    modifiers: 0,
  });
  assert.deepEqual(inputCommand({ kind: 'text', text: 'hello ✓' }), { method: 'Input.insertText', params: { text: 'hello ✓' } });
  for (const bad of [
    { type: 'press', key: 'a' },
    { type: 'down' },
    { type: 'down', key: '' },
    { type: 'down', key: 'x'.repeat(65) },
    { type: 'down', key: 'a', code: 5 },
    { type: 'down', key: 'a', text: 'x'.repeat(9) },
    { type: 'down', key: 'a', keyCode: 256 },
    { type: 'down', key: 'a', keyCode: 1.5 },
  ])
    assert.equal(inputCommand({ kind: 'key', ...bad }), null, JSON.stringify(bad));
  for (const bad of [
    null,
    undefined,
    'x',
    5,
    {},
    { kind: 'drag' },
    { kind: 'text' },
    { kind: 'text', text: '' },
    { kind: 'text', text: 'x'.repeat(10_001) },
    { kind: 'text', text: 7 },
  ])
    assert.equal(inputCommand(bad), null);
});

function setup(o: { tab?: any; tabs?: any; report?: (what: string, error: unknown) => void } = {}) {
  const handlers = new Map<string, (...a: any[]) => any>();
  const ipcMain = { handle: (c: string, fn: (...a: any[]) => any) => void handlers.set(c, fn) };
  const sent: any[] = [];
  const destroyedFns: (() => void)[] = [];
  const sender: any = {
    id: 7,
    destroyed: false,
    isDestroyed: () => sender.destroyed,
    send: (c: string, m: any) => sent.push([c, m]),
    once: (_e: string, fn: () => void) => destroyedFns.push(fn),
  };
  const frames: any[] = [];
  const tab = o.tab ?? { takenOver: true, sends: [] as any[], send: async (m: string, p: any) => void tab.sends.push([m, p]) };
  const remote: any = {
    frame: async (chatId: string, tabKey: string) => (
      frames.push([chatId, tabKey]),
      { data: Buffer.from('jpeg'), mime: 'image/jpeg', width: 800, height: 600, url: 'https://x.test/', title: 'X', loading: false }
    ),
    byKey: () => tab,
  };
  const hosts = { existing: (id: string) => (id === 'box' ? (o.tabs ?? remote) : null) };
  /** a poller that lets the test run a fetch and see how it was asked to show */
  const polls: any[] = [];
  const poller = ({ fetch }: any) => ({
    watch: (w: any) => {
      const p = { w, fetch, visible: undefined as any, takeover: undefined as any, stopped: false };
      polls.push(p);
      return { setVisible: (v: boolean) => (p.visible = v), setTakeover: (v: boolean) => (p.takeover = v), stop: () => (p.stopped = true) };
    },
  });
  const view = registerRemoteView({ ipcMain, hosts: () => hosts, poller, report: o.report });
  const call = (c: string, ...a: any[]) => handlers.get(c)!({ sender }, ...a);
  return { call, sent, sender, polls, frames, tab, view, destroyedFns, hosts };
}
const key = encodeTabKey('box', 'tab_1');

test('a pane watching a tab on a Host gets its frames and errors pushed to its window, and the pane says how it shows it', async () => {
  const w = setup();
  assert.equal(await w.call('browser:remoteWatch', 'pane1', 'chat1', key), true);
  const poll = w.polls[0];
  assert.deepEqual([poll.w.chatId, poll.w.tabKey], ['chat1', 'tab_1']);
  // the poller fetches through the Host's tabs
  await poll.fetch('chat1', 'tab_1');
  assert.deepEqual(w.frames, [['chat1', 'tab_1']]);
  poll.w.onFrame({
    data: Buffer.from('jpeg'),
    mime: 'image/jpeg',
    width: 800,
    height: 600,
    url: 'https://x.test/',
    title: 'X',
    loading: true,
  });
  poll.w.onError(new Error('The page did not answer.'));
  poll.w.onError('plain');
  assert.deepEqual(w.sent, [
    [
      'browser:remoteFrame',
      {
        paneId: 'pane1',
        data: Buffer.from('jpeg').toString('base64'),
        mime: 'image/jpeg',
        width: 800,
        height: 600,
        url: 'https://x.test/',
        title: 'X',
        loading: true,
      },
    ],
    ['browser:remoteFrame', { paneId: 'pane1', error: 'The page did not answer.' }],
    ['browser:remoteFrame', { paneId: 'pane1', error: 'Plain.' }],
  ]);
  assert.equal(await w.call('browser:remoteView', 'pane1', { visible: true, takeover: false }), true);
  assert.deepEqual([poll.visible, poll.takeover], [true, false]);
  await w.call('browser:remoteView', 'pane1', { visible: 'yes', takeover: 1 });
  assert.deepEqual([poll.visible, poll.takeover], [true, false], 'only booleans change it');
  assert.equal(await w.call('browser:remoteView', 'nope', { visible: true }), false);
  assert.equal(await w.call('browser:remoteView', 'pane1', null), false);
  assert.equal(w.view.watching(), 1);
  // a window that is gone gets nothing
  w.sender.destroyed = true;
  poll.w.onError(new Error('late'));
  assert.equal(w.sent.length, 3);
});

test('A3: watching again replaces the earlier watch; stopping, the window closing and stopAll end them', async () => {
  const w = setup();
  await w.call('browser:remoteWatch', 'pane1', 'chat1', key);
  await w.call('browser:remoteWatch', 'pane1', 'chat1', encodeTabKey('box', 'tab_2'));
  assert.deepEqual(
    w.polls.map((p: any) => p.stopped),
    [true, false],
  );
  assert.equal(await w.call('browser:remoteStop', 'pane1'), true);
  assert.equal(w.polls[1].stopped, true);
  assert.equal(await w.call('browser:remoteStop', 'pane1'), false);
  await w.call('browser:remoteWatch', 'pane2', 'chat1', key);
  for (const fn of w.destroyedFns) fn();
  assert.equal(w.view.watching(), 0);
  await w.call('browser:remoteWatch', 'pane3', 'chat1', key);
  w.view.stopAll();
  assert.equal(w.view.watching(), 0);
});

test('B1: a watch needs a pane, a chat and a key that names a tab on a Host that has tabs here', async () => {
  const w = setup();
  for (const args of [
    [undefined, 'chat1', key],
    ['', 'chat1', key],
    ['pane1', undefined, key],
    ['pane1', '', key],
    ['pane1', 'chat1', null],
    ['pane1', 'chat1', 'tab_1'],
    ['pane1', 'chat1', encodeTabKey('other', 'tab_1')],
  ])
    assert.equal(await w.call('browser:remoteWatch', ...args), false, JSON.stringify(args));
  assert.equal(w.polls.length, 0);
  assert.equal(await setup({ tabs: null }).call('browser:remoteWatch', 'pane1', 'chat1', key), true, 'a Host with tabs is watched');
  const none = setup();
  none.hosts.existing = () => null as any;
  assert.equal(await none.call('browser:remoteWatch', 'pane1', 'chat1', key), false);
});

test('I2: input reaches the page only from the pane that watches the tab, only while the user has taken it over, and only when well formed', async () => {
  const w = setup();
  const click = { kind: 'mouse', type: 'down', x: 5, y: 6 };
  assert.equal(await w.call('browser:remoteInput', 'pane1', click), false, 'not watching');
  await w.call('browser:remoteWatch', 'pane1', 'chat1', key);
  assert.equal(await w.call('browser:remoteInput', 'pane1', click), true);
  assert.deepEqual(w.tab.sends, [
    [
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: 5, y: 6, button: 'left', buttons: 1, clickCount: 1, deltaX: 0, deltaY: 0, modifiers: 0 },
    ],
  ]);
  assert.equal(await w.call('browser:remoteInput', 'pane1', { kind: 'mouse', type: 'down', x: 'a', y: 1 }), false);
  assert.equal(w.tab.sends.length, 1);
  // handed back: the agent's page is watched, not driven
  w.tab.takenOver = false;
  assert.equal(await w.call('browser:remoteInput', 'pane1', click), false);
  w.tab.takenOver = true;
  w.tab.send = async () => {
    throw new Error('page crashed');
  };
  assert.equal(await w.call('browser:remoteInput', 'pane1', click), false);
  await tick();
  // told to the app's reporter when it gave one
  const reported: string[] = [];
  const r = setup({ report: (what, error) => reported.push(`${what}: ${(error as Error).message}`) });
  await r.call('browser:remoteWatch', 'pane1', 'chat1', key);
  r.tab.send = async () => {
    throw new Error('page crashed');
  };
  assert.equal(await r.call('browser:remoteInput', 'pane1', click), false);
  assert.deepEqual(reported, ["forward the user's input to a tab on a Host: page crashed"]);
});

test('a tab that is gone, or whose Host went, takes no input', async () => {
  const w = setup({ tab: undefined });
  await w.call('browser:remoteWatch', 'pane1', 'chat1', key);
  const click = { kind: 'mouse', type: 'down', x: 1, y: 2 };
  w.hosts.existing = () => null as any;
  assert.equal(await w.call('browser:remoteInput', 'pane1', click), false);
  const closed = setup();
  await closed.call('browser:remoteWatch', 'pane1', 'chat1', key);
  closed.hosts.existing = () => ({ byKey: () => null }) as any;
  assert.equal(await closed.call('browser:remoteInput', 'pane1', click), false);
});

test("the pane's agent-tab IPC serves the remote view of the Hosts it knows, and none for an app without them", async () => {
  const { registerAgentTabs } = require('../electron/capabilities/browser/agentTabs.cjs');
  const handlers = new Map<string, (...a: any[]) => any>();
  const ipcMain = { handle: (c: string, fn: (...a: any[]) => any) => void handlers.set(c, fn) };
  const sender: any = { id: 1, isDestroyed: () => false, send: () => undefined, once: () => undefined };
  const base = { ipcMain, tabs: () => null, grants: () => null, broadcast: () => undefined, stop: async () => undefined };
  registerAgentTabs({
    ...base,
    report: () => undefined,
    hosts: () => ({ existing: () => ({ frame: async () => ({}) }), entries: () => [] }),
  });
  assert.equal(await handlers.get('browser:remoteWatch')!({ sender }, 'p1', 'chat1', key), true);
  handlers.clear();
  registerAgentTabs(base);
  assert.equal(await handlers.get('browser:remoteWatch')!({ sender }, 'p1', 'chat1', key), false);
});

test('isDesktopTabKey: only a Host’s desktop key says desktop', async () => {
  const { isDesktopTabKey } = await import('../src/lib/hostTabKey.ts');
  assert.equal(isDesktopTabKey(JSON.stringify(['host', 'h1', 'desktop'])), true);
  assert.equal(isDesktopTabKey(JSON.stringify(['host', 'h1', 'tab_x'])), false);
  assert.equal(isDesktopTabKey(JSON.stringify(['host', 'local', 'desktop'])), false);
  for (const bad of ['desktop', '', null, undefined, '[1]', '[not json']) assert.equal(isDesktopTabKey(bad as any), false);
});
