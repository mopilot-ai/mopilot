// The browser tabs a machine's chats use (electron/app/remoteBrowserWiring.cjs, electron/app/ipc/host.cjs; package 2.6): RemoteTabs over the machine's connected Host, none while it connects, and the Host's services main late-binds for the tabs of every Host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { remoteBrowserFactory } = require('../electron/app/remoteBrowserWiring.cjs');
const { RemoteTabs } = require('../electron/capabilities/browser/remoteHost.cjs');
const { PageHang } = require('../electron/capabilities/browser/pageHang.cjs');
const { register } = require('../electron/app/ipc/host.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');

/** The head of a PNG that says it is `w` by `h`: signature, then an IHDR chunk. */
function png(w: number, h: number) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

/** A connected remote Host as the transport sees it: browser requests, events, state. */
function fakeHost() {
  const eventFns = new Set<unknown>();
  const stateFns = new Set<unknown>();
  return {
    eventFns,
    stateFns,
    browser: {
      request: async () => ({}),
      onEvent: (fn: unknown) => (eventFns.add(fn), () => void eventFns.delete(fn)),
    },
    state: () => 'online',
    onState: (fn: unknown) => (stateFns.add(fn), () => void stateFns.delete(fn)),
  };
}

test('a machine that is not connected has no tabs yet; a connected one gets RemoteTabs named for it, and its abort follows the registry', () => {
  const host = fakeHost();
  let connected: ReturnType<typeof fakeHost> | null = null;
  const aborts: unknown[] = [];
  const live: any = {
    connectedHostFor: (id: string) => (id === 'box' ? connected : null),
    capabilities: { onAbort: (fn: unknown) => (aborts.push(fn), () => undefined) },
    controller: { ref: (id: string) => ({ kind: `kind-of-${id}` }) },
    chats: { record: (id: string) => `record-of-${id}` },
  };
  const decoded: Buffer[] = [];
  const nativeImage = { createFromBuffer: (b: Buffer) => (decoded.push(b), 'image') };
  const chatModel = (kind: string, record: unknown, prefs: unknown) => `${kind}|${record}|${prefs}`;
  const make = remoteBrowserFactory({ live, nativeImage, chatModel, uiPrefs: () => 'prefs', hang: new PageHang() });
  assert.equal(make('box', { onChange: () => undefined }), null);
  assert.equal(make('other', { onChange: () => undefined }), null);
  connected = host;
  const tabs = make('box', { onChange: () => undefined });
  assert.ok(tabs instanceof RemoteTabs);
  assert.equal(tabs.hostId, 'box');
  assert.equal(aborts.length, 1);
  assert.equal(host.eventFns.size, 1);
  // screenshots decode with Electron's, and are sized for the chat's model
  assert.equal(tabs.o.images.fromBuffer(png(10, 10)), 'image');
  assert.equal(decoded.length, 1);
  // M5: bytes the decoder should not see are refused before it
  assert.throws(() => tabs.o.images.fromBuffer(Buffer.from('x')), { code: 'capture_failed' });
  assert.equal(decoded.length, 1);
  assert.equal(tabs.o.modelOf('c1'), 'kind-of-c1|record-of-c1|prefs');
  // when the machine leaves, the tabs and their transport stop following its Host
  tabs.dispose();
  assert.deepEqual([host.eventFns.size, host.stateFns.size], [0, 0]);
  // an app with no Host services at all has none either
  assert.equal(
    remoteBrowserFactory({ live: {}, nativeImage, chatModel, uiPrefs: () => 1, hang: new PageHang() })('box', {
      onChange: () => undefined,
    }),
    null,
  );
});

function ipc(t: any, o: { allowed?: () => boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-browser-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map<string, (...a: any[]) => any>();
  const calls: string[] = [];
  const hostTabs = { dropHost: (id: string) => calls.push(`drop ${id}`), noticeAll: () => calls.push('notice') };
  const live: any = { hostTabs, hostContinue: async () => 'moved' };
  const made: any[] = [];
  const svc: any = {
    list: () => ({ machines: [], resolved: true }),
    capabilities: () => ({}),
    connectedHost: (id: string) => `host ${id}`,
    remove: (id: string) => void calls.push(`remove ${id}`),
  };
  register(
    { handle: (c: string, fn: (...a: any[]) => any) => void handlers.set(c, fn) },
    { live, app: { getPath: () => dir }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    {
      create: ((opts: any) => (made.push(opts), svc)) as any,
      allowed: o.allowed ?? (() => true),
    },
  );
  return { dir, live, handlers, calls, made, svc };
}

test("main binds which Host runs a chat (this Mac while Host is off), a machine's connected Host, and the tabs of a machine that goes", async (t) => {
  let allowed = false;
  const w = ipc(t, { allowed: () => allowed });
  assert.deepEqual(w.live.hostOwnership.get('c1'), { hostId: 'local' }, 'Host off');
  allowed = true;
  assert.deepEqual(w.live.hostOwnership.get('c1'), { hostId: 'local', epoch: 0 }, 'a chat nobody moved');
  new OwnershipStore(path.join(w.dir, 'host-ownership.json')).set('c1', { hostId: 'box', ownerHostId: 'old', epoch: 2 });
  assert.deepEqual(
    w.live.hostOwnership.get('c1'),
    { hostId: 'box', epoch: 2 },
    'where it runs, not who holds it, with the epoch the machine checks',
  );
  assert.equal(w.live.connectedHostFor('box'), 'host box');
  // a machine removed: its record goes, then its tabs
  await w.handlers.get('host:remove')!({}, 'box');
  assert.deepEqual(w.calls, ['remove box', 'drop box']);
  // a connection ended for good drops its tabs too
  w.made[0].onRemoteEnd('box');
  assert.equal(w.calls.at(-1), 'drop box');
  // a continue that finished tells the tabs the chat moved; one that failed does not
  assert.equal((await w.handlers.get('host:continue')!({}, { chatId: 'c1', targetHostId: 'box', cwd: '/w' })).value, 'moved');
  assert.equal(w.calls.at(-1), 'notice');
  const before = w.calls.length;
  w.live.hostContinue = async () => {
    throw new Error('refused');
  };
  assert.equal(
    (await w.handlers.get('host:continue')!({}, { chatId: 'c1', targetHostId: 'box', cwd: '/w' })).error?.message ?? 'x',
    'refused',
  );
  assert.equal(w.calls.length, before);
});

test('an app whose tabs are not wired yet ignores the machine events and a removed machine', async (t) => {
  const w = ipc(t);
  w.live.hostTabs = undefined;
  await w.handlers.get('host:remove')!({}, 'box');
  assert.deepEqual(w.calls, ['remove box']);
  // the machines service is made when a window first asks
  w.handlers.get('host:machines')!({});
  w.made[0].onRemoteEnd('box');
  assert.deepEqual(w.calls, ['remove box']);
});

test("with the tabs of every Host: a chat on a machine that is not connected is refused and retried, then gets that machine's RemoteTabs, and the machine leaving ends them", () => {
  const { createHostTabs } = require('../electron/app/hostTabsWiring.cjs');
  const host = fakeHost();
  let connected: ReturnType<typeof fakeHost> | null = null;
  const live: any = {
    hostOwnership: { get: (chatId: string) => ({ hostId: chatId === 'remote' ? 'box' : 'local' }) },
    connectedHostFor: () => connected,
    capabilities: { onAbort: () => () => undefined },
    controller: { ref: () => ({ kind: 'k' }) },
    chats: { record: () => null },
  };
  live.remoteBrowserTabs = remoteBrowserFactory({
    live,
    nativeImage: { createFromBuffer: () => 'image' },
    chatModel: () => null,
    uiPrefs: () => ({}),
    hang: new PageHang(),
  });
  const local: any = { o: { onChange: () => undefined }, onTurnEnd: () => () => undefined };
  const hostTabs = createHostTabs({ live, local });
  assert.throws(
    () => hostTabs.forHost('box'),
    (e: any) => e.code === 'host_unavailable',
  );
  connected = host;
  const tabs = hostTabs.forHost('box');
  assert.ok(tabs instanceof RemoteTabs);
  assert.equal(hostTabs.forHost('box'), tabs, 'one per Host');
  hostTabs.dropHost('box');
  assert.deepEqual([host.eventFns.size, host.stateFns.size], [0, 0]);
});

test('the windows are told about a tab on a Host: the open and show commands go to the window the user is in, the close to every window, all with the Host-naming pane key', () => {
  const told: any[] = [];
  const sent: any[] = [];
  const windows = [1, 2].map((n) => ({ webContents: { send: (...a: unknown[]) => sent.push([n, ...a]) } }));
  const live: any = {
    connectedHostFor: () => fakeHost(),
    capabilities: { onAbort: () => () => undefined },
    controller: { ref: () => ({ kind: 'k' }) },
    chats: { record: () => null },
  };
  const make = remoteBrowserFactory({
    live,
    nativeImage: { createFromBuffer: () => 'image' },
    chatModel: () => null,
    uiPrefs: () => ({}),
    hang: new PageHang(),
    tell: (wc: unknown, command: string, arg: unknown) => (told.push([wc, command, arg]), true),
    windows: () => windows,
  });
  const tabs = make('box', { onChange: () => undefined });
  const pane = tabs.o;
  pane.open('c1', { tabKey: 'tab_1', focus: true });
  pane.select({ chatId: 'c1', id: 'tab_1' }, { auto: true });
  assert.deepEqual(told, [
    [null, 'open-agent-browser-tab', { chatId: 'c1', tabKey: JSON.stringify(['host', 'box', 'tab_1']), focus: true }],
    [null, 'select-agent-browser-tab', { chatId: 'c1', tabKey: JSON.stringify(['host', 'box', 'tab_1']), auto: true }],
  ]);
  tabs.o.close({
    chatId: 'c1',
    id: 'tab_1',
    backend: { targetId: null, created: Promise.reject(new Error('never opened')), gone: () => undefined },
  });
  assert.deepEqual(
    sent.map((s) => [s[0], s[1], s[2]]),
    [
      [1, 'app:command', 'close-agent-browser-tab'],
      [2, 'app:command', 'close-agent-browser-tab'],
    ],
  );
  assert.deepEqual(sent[0][3], { chatId: 'c1', tabKey: JSON.stringify(['host', 'box', 'tab_1']) });
  tabs.dispose();
});
