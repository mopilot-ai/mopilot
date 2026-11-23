// Who a chat's tool calls go to (host/src/toolRelay.mjs, host/src/protocol.mjs; F2): only an app that announced tools can own, the latest sender wins, a subscribe fills an empty seat only, and the owner leaving hands later calls to a watcher without resending the call in flight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { createToolRelay } from '../host/src/toolRelay.mjs';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const S = require('../shared/host/schema.mjs');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-owners-')));
const TOOL = { name: 'browser_open', description: 'open', inputSchema: { type: 'object', properties: {} }, policy: 'act' };
/** One chat per harness family: the relay treats them alike. */
const CHATS = ['claude:c1', 'codex:c1', 'acp:fake:c1'];

/** A fake Host (protocol over a real relay and registry) that apps connect to; an app answers every call it is sent, naming itself. */
async function host() {
  const registry = new Registry();
  const relay = createToolRelay({ registry });
  const runtime: any = { host: Object.assign(new EventEmitter(), { cancel: async () => undefined }), send: async () => ({ turnId: 't' }) };
  const epochs = createEpochStore(path.join(dir, `e-${Math.random()}.json`), { report: () => undefined });
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, `l-${Math.random()}`), { report: () => undefined }) });
  const protocol = createProtocol({ runtime, epochs, guard, status: () => ({ running: true }), tools: relay });
  let keys = 0;
  /** @param {string} name @param {{ tools?: boolean, identity?: string | null, answers?: boolean }} o */
  const app = async (name: string, o: { tools?: boolean; identity?: string | null; answers?: boolean } = {}) => {
    const sent: any[] = [];
    const conn = protocol.connection(
      (m: any) => {
        sent.push(m);
        if (m.event === 'tool' && o.answers !== false)
          queueMicrotask(() =>
            conn.call('host.toolResult', {
              chatId: m.chatId,
              epoch: m.epoch,
              callId: m.callId,
              ok: true,
              content: [{ type: 'text', text: name }],
            }),
          );
      },
      () => (o.identity === undefined ? name : o.identity),
    );
    await conn.call('host.hello', { protocol: S.PROTOCOL, features: [...S.FEATURES] });
    if (o.tools !== false) await conn.call('host.toolsSync', { tools: [TOOL] });
    return {
      conn,
      sent,
      subscribe: (chatId: string) => conn.call('chat.subscribe', { chatId, epoch: epochs.current(chatId), fromRev: 0 }),
      send: (chatId: string) =>
        conn.call('chat.send', { chatId, epoch: epochs.current(chatId), key: `key-${name}-${++keys}-0001`, text: 'hi' }),
    };
  };
  /** Who ran a call: the app's name, or the refusal's code. */
  const run = async (chatId: string) => {
    const r = await registry.invoke(chatId, 's', 'browser_open', {});
    return r.ok ? r.content[0].text : r.error.code;
  };
  // an app that owns no chat keeps the tool registered while a chat has no owner (a tool nobody announces is unknown, not offline)
  await app('anchor');
  return { app, run, registry };
}

for (const chat of CHATS) {
  test(`A1: ${chat}: two apps subscribe in both orders, the one that sent keeps the chat`, async () => {
    const h = await host();
    const a = await h.app('a');
    const b = await h.app('b');
    await a.send(chat);
    await b.subscribe(chat);
    assert.equal(await h.run(chat), 'a');
    // the other order: the watcher first, the sender after
    const c = await h.app('c');
    const d = await h.app('d');
    await c.subscribe(`${chat}-2`);
    await d.send(`${chat}-2`);
    await c.subscribe(`${chat}-2`);
    assert.equal(await h.run(`${chat}-2`), 'd');
    // a later send by the other app takes it
    await c.send(`${chat}-2`);
    assert.equal(await h.run(`${chat}-2`), 'c');
  });
}

test('B6: an app with no tools subscribes and sends and never owns; with no owner a call is app_offline', async () => {
  const h = await host();
  const phone = await h.app('phone', { tools: false });
  await phone.subscribe('claude:c1');
  await phone.send('claude:c1');
  assert.equal(await h.run('claude:c1'), 'app_offline');
  const mac = await h.app('mac');
  await mac.send('claude:c1');
  await phone.send('claude:c1');
  assert.equal(await h.run('claude:c1'), 'mac');
  // an app that announces an empty list is no longer eligible, and the chat goes to a watcher that can
  const other = await h.app('other');
  await other.subscribe('claude:c1');
  await mac.conn.call('host.toolsSync', { tools: [] });
  assert.equal(await h.run('claude:c1'), 'other');
  await other.conn.call('host.toolsSync', { tools: [] });
  assert.equal(await h.run('claude:c1'), 'app_offline');
});

test('an app that subscribes first and announces its tools after takes a chat nobody owns', async () => {
  const h = await host();
  const late = await h.app('late', { tools: false });
  await late.subscribe('codex:c1');
  assert.equal(await h.run('codex:c1'), 'app_offline');
  await late.conn.call('host.toolsSync', { tools: [TOOL] });
  assert.equal(await h.run('codex:c1'), 'late');
});

test('A3: the owner disconnects mid-call: that call ends app_offline and is never resent, the next goes to the latest watcher', async () => {
  const h = await host();
  const a = await h.app('a', { answers: false });
  const old = await h.app('old');
  const recent = await h.app('recent');
  const phone = await h.app('phone', { tools: false });
  await old.subscribe('claude:c1');
  await recent.subscribe('claude:c1');
  await phone.subscribe('claude:c1');
  await a.send('claude:c1');
  const inFlight = h.run('claude:c1');
  while (!a.sent.some((m) => m.event === 'tool')) await new Promise((r) => setTimeout(r, 5));
  a.conn.close();
  assert.equal(await inFlight, 'app_offline');
  assert.equal(await h.run('claude:c1'), 'recent');
  assert.equal(old.sent.filter((m) => m.event === 'tool').length, 0);
  assert.equal(recent.sent.filter((m) => m.event === 'tool').length, 1);
  // a watcher that left before the owner is not a fallback
  recent.conn.close();
  assert.equal(await h.run('claude:c1'), 'old');
});

test('A5: after a reconnect the same app’s first toolsSync takes its chats back, before any subscribe; another app does not', async () => {
  const h = await host();
  const first = await h.app('mac', { identity: 'client-1' });
  await first.send('claude:c1');
  await first.send('acp:fake:c1');
  first.conn.close();
  assert.equal(await h.run('claude:c1'), 'app_offline');
  const stranger = await h.app('stranger', { identity: 'client-2' });
  assert.equal(await h.run('claude:c1'), 'app_offline');
  const back = await h.app('mac2', { identity: 'client-1' });
  assert.equal(await h.run('claude:c1'), 'mac2');
  assert.equal(await h.run('acp:fake:c1'), 'mac2');
  // a chat someone else already took is not taken back
  back.conn.close();
  await stranger.send('claude:c1');
  await h.app('mac3', { identity: 'client-1' });
  assert.equal(await h.run('claude:c1'), 'stranger');
  assert.equal(await h.run('acp:fake:c1'), 'mac3');
});

test('a chat that was orphaned and then watched by an app that can own goes to that app, not to the returning one', async () => {
  const h = await host();
  const first = await h.app('mac', { identity: 'client-1' });
  await first.send('claude:c1');
  first.conn.close();
  const watcher = await h.app('watcher', { identity: 'client-2' });
  await watcher.subscribe('claude:c1');
  await h.app('mac2', { identity: 'client-1' });
  assert.equal(await h.run('claude:c1'), 'watcher');
});
