// The tool relay on a machine's connection (electron/host/machines.cjs `onRemoteHost`, electron/host/toolRelay.cjs, package 2.6): the app announces its tools straight after the hello, before any chat is sent, and again after every reconnect; a call the Host relays is run and answered; the relay ends with the connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const U = '3f2b6f58-4a1e-4e0b-9b7c-1d2e3f4a5b6c';
// @ts-ignore: plain ESM without declarations
import { FEATURES } from '../shared/host/schema.mjs';
import { hostWorld, tick } from './support/host-wire-kit.ts';
import { keySafe } from './support/hostKeySafe.ts';

const require = createRequire(import.meta.url);
const { createMachines, hostOwnership } = require('../electron/host/machines.cjs');
const { createToolRelay } = require('../electron/host/toolRelay.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');

const record = { id: 'ssh:box', name: 'box', address: 'me@box', socketPath: '/h/host.sock', harnesses: [] as any[], capabilities: {} };
const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await tick();
};

function setup(t: any, o: { throwOnWire?: boolean; noTools?: boolean } = {}) {
  const w = hostWorld(t);
  w.net.handlers['host.challenge'] = () => ({ nonce: 'n-1', hostId: 'abababababababababababababababab' });
  w.net.handlers['host.auth'] = () => ({ fingerprint: 'f' });
  w.net.handlers['host.hello'] = () => ({
    protocol: { minor: 1, floor: 1 },
    features: FEATURES.filter((f: string) => !(o.noTools && f === 'tools')),
  });
  w.net.handlers['host.toolsSync'] = () => ({ registered: [], skipped: [] });
  w.net.handlers['host.toolResult'] = () => ({ accepted: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machines-relay-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry: any = {
    list: () => [
      { name: 'browser_navigate', description: 'Open', inputSchema: { type: 'object', properties: {} }, policy: 'act' },
      { name: 'desktop_click', description: 'Click', inputSchema: { type: 'object', properties: {} }, policy: 'act' },
    ],
    invoke: async (...args: any[]) => (invoked.push(args), { ok: true, content: [{ type: 'text', text: 'Opened' }] }),
  };
  const invoked: any[][] = [];
  const reports: string[] = [];
  const wired: string[] = [];
  // the ownership file decides which chats a machine may call tools for, as in electron/app/ipc/host.cjs
  const owned = hostOwnership({ dir, allowed: () => true });
  const own = (chatId: string, hostId = 'ssh:box', epoch = 3) =>
    new OwnershipStore(path.join(dir, 'host-ownership.json')).set(chatId, { hostId, ownerHostId: hostId, epoch });
  const m = createMachines({
    safeStorage: keySafe,
    dir,
    registry: {
      list: () => [record],
      resolved: () => true,
      onChange: () => () => undefined,
      start: () => undefined,
      stop: () => undefined,
      dispose: () => undefined,
      check: async () => undefined,
      remove: () => undefined,
    } as any,
    installer: {} as any,
    allowed: () => true,
    watch: () => () => undefined,
    pool: { get: () => w.tunnel() } as any,
    connect: w.net.connect,
    onRemoteHost: (id: string, host: any) => {
      wired.push(id);
      if (o.throwOnWire) throw new Error('no relay today');
      const relay = createToolRelay({
        host,
        registry,
        include: (x: { name: string }) => x.name.startsWith('browser_'),
        owns: (chatId: string) => owned.get(chatId).hostId === id,
        report: (what: string) => reports.push(what),
      });
      return () => relay.dispose();
    },
  });
  t.after(() => m.dispose());
  const online = async () => {
    for (let i = 0; i < 12; i++) {
      const host = m.connectedHost('ssh:box');
      if (host) return host;
      await settle();
      w.clock.advance(1000);
      await settle();
    }
    return m.connectedHost('ssh:box');
  };
  /** The socket the Host connection speaks on now: the newest one that was asked something. */
  const live = () => [...w.net.sockets].reverse().find((s: any) => s.written.length > 0 && !s.destroyed);
  const wire = () => w.net.sockets.flatMap((s: any) => s.written.map((x: any) => x.method)).filter(Boolean);
  return { w, m, dir, online, invoked, reports, wired, wire, live, own };
}

test('the tools are announced straight after the hello, before any chat call, and only the browser tools', async (t) => {
  const { w, online, wire } = setup(t);
  await online();
  const methods = wire();
  assert.ok(methods.indexOf('host.hello') >= 0 && methods.indexOf('host.toolsSync') > methods.indexOf('host.hello'));
  assert.equal(
    methods.some((m: string) => m.startsWith('chat.')),
    false,
    'no chat has been started yet',
  );
  const sync = w.net.sockets.flatMap((s: any) => s.written).find((x: any) => x.method === 'host.toolsSync');
  assert.deepEqual(
    sync.params.tools.map((x: any) => x.name),
    ['browser_navigate'],
  );
});

test('a call the Host relays is run for its chat and answered with its epoch; a duplicate while it runs is not run twice', async (t) => {
  const { online, invoked, live, own } = setup(t);
  own('c1');
  await online();
  const call = {
    event: 'tool',
    chatId: 'c1',
    segmentId: 's1',
    callId: 'k1',
    name: 'browser_navigate',
    arguments: { url: 'https://x.test/' },
    epoch: 3,
  };
  live()!.feed(call);
  await settle();
  assert.equal(invoked.length, 1);
  assert.deepEqual(invoked[0].slice(0, 4), ['c1', 's1', 'browser_navigate', { url: 'https://x.test/' }]);
  const answer = live()!.written.find((x: any) => x.method === 'host.toolResult');
  assert.deepEqual(answer.params, { chatId: 'c1', callId: 'k1', epoch: 3, ok: true, content: [{ type: 'text', text: 'Opened' }] });
});

test('a reconnect announces the tools again, and a connection that was removed hears the Host no more', async (t) => {
  const { m, online, invoked, wire, live } = setup(t);
  await online();
  assert.equal(wire().filter((x: string) => x === 'host.toolsSync').length, 1);
  // the connection drops and comes back
  live()!.destroy();
  await settle();
  await online();
  assert.equal(wire().filter((x: string) => x === 'host.toolsSync').length, 2);
  // the machine leaves: the relay is detached with the connection
  const socket = live()!;
  m.remove('ssh:box');
  socket.feed({ event: 'tool', chatId: 'c1', segmentId: 's1', callId: 'k2', name: 'browser_navigate', arguments: {}, epoch: 3 });
  await settle();
  assert.equal(invoked.length, 0);
});

test('B: a relay that cannot be set up leaves the connection working and is reported, not thrown', async (t) => {
  const { online, wired, wire } = setup(t, { throwOnWire: true });
  const host = await online();
  assert.equal(host.state(), 'online');
  assert.deepEqual(wired, ['ssh:box']);
  assert.equal(wire().includes('host.toolsSync'), false, 'no relay, nothing announced');
});

test('I: a chat the Host names claude:<id> is the app’s acp:host-claude:<id> to the registry, and its answer goes back under the Host’s id', async (t) => {
  const { dir, online, invoked, live } = setup(t);
  const appId = `acp:host-claude:${U}`;
  new OwnershipStore(path.join(dir, 'host-ownership.json')).set(appId, { hostId: 'ssh:box', ownerHostId: 'ssh:box', epoch: 5 });
  await online();
  live()!.feed({ event: 'tool', chatId: `claude:${U}`, segmentId: 's1', callId: 'k9', name: 'browser_navigate', arguments: {}, epoch: 5 });
  await settle();
  assert.equal(invoked[0][0], appId);
  const answer = live()!.written.find((x: any) => x.method === 'host.toolResult');
  assert.equal(answer.params.chatId, `claude:${U}`);
  assert.equal(answer.params.epoch, 5);
});

test('a Host cannot call a tool it was not offered, or one for a chat of this Mac or of another machine', async (t) => {
  const { online, invoked, reports, live, own } = setup(t);
  own('c-other', 'ssh:elsewhere');
  await online();
  const call = { event: 'tool', segmentId: 's1', callId: 'k', arguments: {}, epoch: 3 };
  live()!.feed({ ...call, chatId: 'c1', callId: 'k1', name: 'desktop_click' });
  live()!.feed({ ...call, chatId: 'local-chat', callId: 'k2', name: 'browser_navigate' });
  live()!.feed({ ...call, chatId: 'c-other', callId: 'k3', name: 'browser_navigate' });
  await settle();
  assert.equal(invoked.length, 0);
  assert.equal(reports.length, 3);
});

test('a Host without the tools feature is not served, and the listeners made after the relay still hear it come online', async (t) => {
  const { m, online, reports, wire } = setup(t, { noTools: true });
  // the relay is made with the connection; the next listener (the mirror's, the outbox's) comes after it
  const host = m.hostFor('ssh:box');
  const heard: string[] = [];
  host.onState((s: string) => heard.push(s));
  assert.equal((await online()).state(), 'online');
  assert.ok(heard.includes('online'), 'a listener after the relay was told');
  assert.equal(wire().includes('host.toolsSync'), false, 'nothing was announced to a Host that cannot take it');
  assert.deepEqual(reports, [], 'a Host without the feature is simply not served, not a failure');
});
