// A chat of another family on a Host has one id here and another on the Host (shared/host/chatIds.mjs, electron/host/chatIds.cjs): the pure mapping, the translation at a Host's edge, and the machines service that applies it to a real connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { appChatId, hostChatId } from '../shared/host/chatIds.mjs';
import { hostWorld, tick } from './support/host-wire-kit.ts';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { withAppChatIds } = require('../electron/host/chatIds.cjs');
const { createMachines } = require('../electron/host/machines.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');

const U = '3f2b6f58-4a1e-4e0b-9b7c-1d2e3f4a5b6c';

test('a Claude Code chat is claude:<id> on the Host, a Codex chat its bare id, and an ACP chat the same everywhere', () => {
  assert.equal(hostChatId(`acp:host-claude:${U}`), `claude:${U}`);
  assert.equal(hostChatId(`acp:host-codex:${U}`), U);
  assert.equal(hostChatId(`acp:kimi:${U}`), `acp:kimi:${U}`);
  assert.equal(appChatId(`claude:${U}`), `acp:host-claude:${U}`);
  assert.equal(appChatId(U), `acp:host-codex:${U}`);
  assert.equal(appChatId(`acp:kimi:${U}`), `acp:kimi:${U}`);
  for (const id of [`acp:host-claude:${U}`, `acp:host-codex:${U}`, `acp:kimi:${U}`]) assert.equal(appChatId(hostChatId(id)), id);
});

function fakeHost() {
  const asked: any[] = [];
  const listeners: Record<string, ((p: any) => void)[]> = {};
  const on = (name: string) => (fn: (p: any) => void) => {
    (listeners[name] ??= []).push(fn);
    return () => void listeners[name].splice(listeners[name].indexOf(fn), 1);
  };
  const record =
    (name: string) =>
    async (...args: any[]) => (asked.push([name, ...args]), { name });
  const host: any = {
    state: () => 'online',
    send: record('send'),
    start: record('start'),
    stop: record('stop'),
    answer: record('answer'),
    permit: record('permit'),
    subscribe: async (chatId: string, ...rest: any[]) => {
      asked.push(['subscribe', chatId, ...rest]);
      return host.reply;
    },
    reply: { snapshot: { rev: 1 }, patches: [{ chatId: U, rev: 1, patch: {} }] },
    browser: { request: record('browser.request'), onEvent: on('browser'), other: 'kept' },
    tools: { request: record('tools.request'), onEvent: on('tools') },
    events: { onPatch: on('patch'), onFrame: on('frame'), onClosed: on('closed'), onResync: on('resync'), onInflight: on('inflight') },
  };
  return { host, asked, listeners };
}

test('the Host is asked with its own ids and answers with the app’s, and what it does not know of chats passes through', async () => {
  const { host, asked, listeners } = fakeHost();
  const view = withAppChatIds(host, (id: string) => id.startsWith('acp:host-'));
  assert.equal(
    withAppChatIds(host, () => false),
    view,
    'one wrapper per Host',
  );
  assert.equal(view.state(), 'online');
  const claude = `acp:host-claude:${U}`;
  await view.send(claude, { text: 'hi' }, { key: 'k' });
  await view.start(`acp:host-codex:${U}`, { harness: 'codex' });
  await view.stop(claude, undefined, { key: 'k2' });
  await view.answer({ chatId: claude, requestId: 'r', optionId: 'allow' });
  await view.permit({ chatId: claude, value: 'plan' });
  await view.permit({ value: 'plan' });
  await view.send(undefined as any, { text: 'no chat' });
  await view.browser.request('browser.open', { chatId: claude });
  await view.tools.request('host.toolResult', { chatId: claude, callId: 'k1' });
  await view.tools.request('host.toolsSync', { tools: [] });
  assert.deepEqual(asked, [
    ['send', `claude:${U}`, { text: 'hi' }, { key: 'k' }],
    ['start', U, { harness: 'codex' }],
    ['stop', `claude:${U}`, undefined, { key: 'k2' }],
    ['answer', { chatId: `claude:${U}`, requestId: 'r', optionId: 'allow' }],
    ['permit', { chatId: `claude:${U}`, value: 'plan' }],
    ['permit', { value: 'plan' }],
    ['send', undefined, { text: 'no chat' }],
    ['browser.request', 'browser.open', { chatId: `claude:${U}` }],
    ['tools.request', 'host.toolResult', { chatId: `claude:${U}`, callId: 'k1' }],
    ['tools.request', 'host.toolsSync', { tools: [] }],
  ]);
  assert.equal(view.browser.other, 'kept');

  asked.length = 0;
  const sub = await view.subscribe(claude, 4, 'g');
  assert.deepEqual(asked, [['subscribe', `claude:${U}`, 4, 'g']]);
  assert.equal(
    sub.patches[0].chatId,
    `acp:host-codex:${U}`,
    'a bare id from the Host is a Codex thread the app lists under its Host-family id',
  );
  host.reply = { snapshot: { rev: 2, items: [] }, patches: null };
  assert.equal((await view.subscribe(claude)).patches, null);

  const heard: any[] = [];
  const offs = [
    view.events.onPatch((p: any) => heard.push(['patch', p.chatId])),
    view.events.onFrame((p: any) => heard.push(['frame', p.chatId])),
    view.events.onClosed((p: any) => heard.push(['closed', p.chatId])),
    view.events.onResync((p: any) => heard.push(['resync', p.chatId])),
    view.events.onInflight((p: any) => heard.push(['inflight', p.chatId])),
    view.browser.onEvent((p: any) => heard.push(['browser', p.chatId])),
    view.tools.onEvent((p: any) => heard.push(['tools', p.chatId, p.callId])),
  ];
  for (const name of ['patch', 'frame', 'closed', 'resync', 'inflight', 'browser', 'tools'])
    listeners[name][0]({ chatId: `claude:${U}`, callId: 'k1' });
  assert.deepEqual(
    heard.map((h) => h[1]),
    Array(7).fill(claude),
  );
  for (const off of offs) off();
  assert.deepEqual(Object.values(listeners).flat(), [], 'each listener can be taken off');
});

test('a request for a chat of another family goes out with the Host’s id and the epoch the ownership file holds under the app’s', async (t) => {
  const w = hostWorld(t);
  w.net.handlers['host.challenge'] = () => ({ nonce: 'n-1', hostId: 'abababababababababababababababab' });
  w.net.handlers['host.auth'] = () => ({ fingerprint: 'f' });
  const seen: any[] = [];
  w.net.handlers['chat.send'] = (p: any) => (seen.push(p), { replayed: false, result: 'ok' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-ids-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const claude = `acp:host-claude:${U}`;
  new OwnershipStore(path.join(dir, 'host-ownership.json')).set(claude, {
    hostId: 'ssh:box',
    ownerHostId: 'ssh:box',
    epoch: 7,
    folder: null,
  });
  const registry = createRegistry({
    file: path.join(dir, 'r.json'),
    status: async () => ({ harnesses: [], capabilities: { shell: true } }),
  });
  registry.add({ id: 'ssh:box', name: 'box', address: 'me@box', socketPath: '/h/host.sock', harnesses: [] });
  const tunnel = w.tunnel();
  const m = createMachines({
    safeStorage: keySafe,
    dir,
    allowed: () => true,
    watch: () => undefined,
    registry,
    installer: {},
    pool: { get: () => tunnel },
    call: async () => ({ harnesses: [], capabilities: { shell: true } }),
    connect: w.net.connect,
  });
  t.after(() => m.dispose());
  const host = m.hostFor('ssh:box');
  assert.equal(m.hostFor('ssh:box'), host);
  await host.connect();
  await host.send(claude, { text: 'hi' });
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].chatId, `claude:${U}`);
  assert.equal(seen[0].epoch, 7);
  // a request with no chat id is the Host's schema to refuse, not a crash of the id lookup
  await assert.rejects(host.permit({ value: 'plan' }), (e: any) => !(e instanceof TypeError));
  // a chat the ownership file gains later is read as a Host-family chat at once
  const other = `acp:host-codex:${U}`;
  new OwnershipStore(path.join(dir, 'host-ownership.json')).set(other, {
    hostId: 'ssh:box',
    ownerHostId: 'ssh:box',
    epoch: 4,
    folder: null,
  });
  await host.send(other, { text: 'again' });
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual([seen[1].chatId, seen[1].epoch], [U, 4]);
});

test('a side chat translates both its own and its parent’s stable id for the same Host', async () => {
  const { host, asked } = fakeHost();
  const view = withAppChatIds(host, () => true);
  for (const [app, wire] of [
    ['acp:host-codex:', ''],
    ['acp:host-claude:', 'claude:'],
    ['acp:kimi:', 'acp:kimi:'],
  ]) {
    const child = `side-chat-${crypto.randomUUID()}`;
    const sideChat = { sourceId: `${app}parent`, epoch: 5 };
    const input = { text: 'question', sideChat };
    await view.start(`${app}${child}`, input);
    assert.deepEqual(asked.at(-1), ['start', `${wire}${child}`, { text: 'question', sideChat: { sourceId: `${wire}parent`, epoch: 5 } }]);
    assert.equal(input.sideChat.sourceId, `${app}parent`, 'the outbox retains the app id for a retry');
  }
});

test('a chat continued to a Host keeps the id it had here: the Host’s id is read as a Host-family chat’s only when the app has one', async () => {
  const { host, listeners } = fakeHost();
  const view = withAppChatIds(host, (id: string) => id === `acp:host-codex:${U}`);
  const heard: string[] = [];
  view.events.onPatch((p: any) => heard.push(p.chatId));
  for (const id of [U, `claude:${U}`, 'other']) listeners.patch[0]({ chatId: id });
  assert.deepEqual(heard, [`acp:host-codex:${U}`, `claude:${U}`, 'other']);
  host.reply = { snapshot: { rev: 1 }, patches: [{ chatId: `claude:${U}`, rev: 1, patch: {} }] };
  assert.equal((await view.subscribe(`claude:${U}`)).patches[0].chatId, `claude:${U}`);
});
