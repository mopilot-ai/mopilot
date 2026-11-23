// Computer use wired up in main with a Host (G8 #3903): the router is registered in place of the plain desktop_* tools, a chat on a Host runs them on its Host's desktop and never on this Mac's, and Stop and the end of a turn reach the Host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rig } = await import('./support/computer-use-setup-rig.ts');
const { createRemoteDesktop } = require('../electron/host/remoteDesktop.cjs');
const { hostDesktopOptions } = require('../electron/host/remoteDesktop.cjs');
const { UNKNOWN_OWNER } = require('../electron/capabilities/hostDesktop.cjs');

const PARITY = { 'shared.computerUse.parityTools': true };

function fakeRemote() {
  const log: any[] = [];
  const remote = {
    lease: async (c: string, apps: any) => void log.push(['lease', c, apps]),
    command: async (c: string, m: string, p: any) => {
      log.push(['command', c, m, p]);
      return m === 'displays.list' ? { displays: [] } : { ok: true };
    },
    release: async (c: string) => void log.push(['release', c]),
    abort: async (c: string) => void log.push(['abort', c]),
    state: async () => ({ available: true }),
    alive: () => true,
  };
  return { remote, log };
}

function withHost() {
  const f = fakeRemote();
  const owners: Record<string, string> = { onHost: 'h1' };
  const r = rig({
    flags: PARITY,
    options: {
      hostOwner: (chatId: string) => owners[chatId] ?? null,
      remoteDesktopFor: (hostId: string) => (hostId === 'h1' ? f.remote : null),
      userIdleSeconds: async () => 1,
    },
  });
  return { ...f, r };
}

test('with a Host, the desktop_* tools are still registered once, as the router', () => {
  const w = withHost();
  const names = w.r.registry.list({ all: true }).map((t: any) => t.name);
  assert.ok(names.includes('desktop_screenshot'));
  assert.equal(names.filter((n: string) => n === 'desktop_screenshot').length, 1);
});

test('a chat on a Host whose Host is not connected gets an error; nothing is done on this Mac', async () => {
  const f = fakeRemote();
  const r = rig({ flags: PARITY, options: { hostOwner: () => 'gone', remoteDesktopFor: () => null, userIdleSeconds: async () => 1 } });
  const res = await r.registry.invoke('c1', 's1', 'desktop_screenshot', {});
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'not_connected');
  assert.equal(f.log.length, 0);
  assert.deepEqual(r.patches, [], 'no chat state of this Mac’s desktop was touched');
});

test('Stop on a chat on a Host reaches its Host; a chat on this Mac does not ask a Host', async () => {
  const w = withHost();
  // the stack for the Host exists once a tool ran there
  await w.r.registry.invoke('onHost', 's1', 'desktop_request_access', { apps: ['Notes'], reason: 'x' });
  w.r.registry.abortChat('onHost');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(w.log.some((l) => l[0] === 'abort' && l[1] === 'onHost'));
  const before = w.log.length;
  w.r.registry.abortChat('c-on-this-mac');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(w.log.length, before);
});

test('the end of a turn lets the Host go of what it held for the chat', async () => {
  const w = withHost();
  await w.r.registry.invoke('onHost', 's1', 'desktop_request_access', { apps: ['Notes'], reason: 'x' });
  w.r.registry.turns.retire('onHost');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(w.log.some((l) => l[0] === 'release' && l[1] === 'onHost'));
});

test('without a Host option, the tools are registered as before (nothing is routed)', async () => {
  const r = rig({ flags: PARITY });
  assert.ok(r.registry.list({ all: true }).some((t: any) => t.name === 'desktop_screenshot'));
});

test('hostDesktopOptions: the machine a chat lives on, its desktop over the live connection (one per connection), and the user’s idle time', async () => {
  const hosts: Record<string, any> = { h1: { desktop: { request: async () => ({}) }, state: () => 'online' } };
  const live: any = {
    hostOwnership: { get: (chatId: string) => ({ hostId: chatId === 'onHost' ? 'h1' : chatId === 'unconnected' ? 'h2' : 'local' }) },
    connectedHostFor: (id: string) => hosts[id] ?? null,
  };
  const o = hostDesktopOptions(live);
  assert.equal(o.hostOwner('onHost'), 'h1');
  assert.equal(o.hostOwner('onMac'), null);
  assert.equal(o.hostOwner('unconnected'), 'h2');
  const first = o.remoteDesktopFor('h1');
  assert.ok(first);
  assert.equal(o.remoteDesktopFor('h1'), first, 'the same RemoteDesktop for the same connection');
  assert.equal(o.remoteDesktopFor('h2'), null, 'not connected');
  hosts.h1 = { desktop: { request: async () => ({}) }, state: () => 'online' };
  assert.notEqual(o.remoteDesktopFor('h1'), first, 'a new connection gets its own');
  // a Host chat's desktop tab changed: the pane's list is told through the live service, set up later than these options
  const told: string[] = [];
  o.desktopTabsChanged('early');
  live.agentTabsChanged = (c: string) => told.push(c);
  o.desktopTabsChanged('c1');
  assert.deepEqual(told, ['c1']);
  assert.equal(typeof o.userIdleSeconds, 'function');
  assert.equal(typeof createRemoteDesktop, 'function');
  const none = hostDesktopOptions({});
  assert.equal(none.hostOwner('c'), UNKNOWN_OWNER, 'where a chat runs cannot be read: its machine is unknown, never this Mac');
  assert.equal(none.remoteDesktopFor('h1'), null);
});

test('the idle time is Electron’s powerMonitor, read when asked', async () => {
  const Module = require('node:module');
  const original = Module._load;
  Module._load = function (request: string, ...rest: any[]) {
    if (request === 'electron') return { powerMonitor: { getSystemIdleTime: () => 7 } };
    return original.call(this, request, ...rest);
  };
  try {
    assert.equal(await hostDesktopOptions({}).userIdleSeconds(), 7);
  } finally {
    Module._load = original;
  }
});

test('a deleted or archived chat (the app calls desktop.forget) and a turn that ended reach the Host through the setup', async () => {
  const w = withHost();
  await w.r.registry.invoke('onHost', 's1', 'desktop_request_access', { apps: ['Notes'], reason: 'x' });
  await w.r.registry.invoke('onHost', 's1', 'desktop_screenshot', {});
  await w.r.runtime.turnEnded('onHost');
  await w.r.runtime.desktop.forget('onHost');
  assert.ok(
    w.log.some((l) => l[0] === 'release' && l[1] === 'onHost'),
    'the Host was told to let go',
  );
  const plain = rig({ flags: PARITY });
  await plain.runtime.desktop.forget('c1');
  await plain.runtime.turnEnded('c1');
});
