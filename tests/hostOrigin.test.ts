// Who wrote the message a Host's turn answers (feature `origin`): the request says so, the Host's turn carries it, and the app reads a turn as a person's only from a Host that carries it. Computer use asks this before it touches a desktop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { FEATURES, helloParams, parseParams } from '../shared/host/schema.mjs';
import { createCodexStream } from '../host/src/codexStream.mjs';
import { CHAT, ev, world } from './support/host/remoteChatsKit.ts';

const require = createRequire(import.meta.url);
const { chatCalls } = require('../electron/host/remoteChatCalls.cjs');
const quiet = { report: () => undefined };

test('the schema carries `human` on a message and a first message, only when it is exactly true', () => {
  assert.ok(FEATURES.includes('origin'));
  const base = { chatId: 'c1', epoch: 1, key: 'key-origin-0001', text: 'hi' };
  assert.equal(parseParams('chat.send', { ...base, human: true }).human, true);
  assert.equal('human' in parseParams('chat.send', base), false);
  assert.equal('human' in parseParams('chat.send', { ...base, human: 'yes' }), false);
  assert.equal(parseParams('chat.start', { ...base, chatId: 'acp:kimi:c1', harness: 'acp:kimi', human: true }).human, true);
});

test('the Host hands the runtime `human` only when the request carried it: a peer message, a scheduled run and an older app are nobody’s', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-origin-'));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const sent: any[] = [];
  const runtime: any = { host, send: async (p: any) => (sent.push(p), { turnId: 't' }), permit: () => true, familyOf: () => 'acp' };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const conn = createProtocol({ runtime, epochs, guard, status: () => ({ running: true }) }).connection(() => undefined);
  await conn.call('host.hello', helloParams());
  let n = 0;
  const send = (p: object) => conn.call('chat.send', { chatId: 'c', epoch: 1, key: `key-origin-${++n}-00`, text: 'x', ...p });
  await send({ human: true });
  await send({});
  assert.deepEqual(
    sent.map((p) => p.human),
    [true, undefined],
  );
});

function calls(speaks: boolean) {
  const asked: any[] = [];
  const c = chatCalls({
    needs: () => undefined,
    request: async (method: string, params: any) => (asked.push([method, params]), { result: {} }),
    epochOf: () => 1,
    mintKey: () => 'key-origin-mint0',
    speaks: (f: string) => speaks && f === 'origin',
  });
  return { c, asked };
}

test('the app says who wrote a message only to a Host that carries it; an older Host is sent what it always was', async () => {
  const on = calls(true);
  await on.c.send('c1', { text: 'a', human: true });
  await on.c.send('c1', { text: 'b' });
  await on.c.start('acp:kimi:c1', { harness: 'acp:kimi', text: 'c', human: true });
  assert.deepEqual(
    on.asked.map(([, p]) => p.human),
    [true, undefined, true],
  );
  const old = calls(false);
  await old.c.send('c1', { text: 'a', human: true });
  await old.c.start('acp:kimi:c1', { harness: 'acp:kimi', text: 'c', human: true });
  assert.deepEqual(
    old.asked.map(([, p]) => p.human),
    [undefined, undefined],
  );
});

test('a Codex turn start carries `human` from the message that started it; a turn nobody asked for (the agent’s own) has none', () => {
  const out: any[] = [];
  const stream = createCodexStream({ emit: (e: any) => out.push(e) } as any);
  stream.started('x1', 'turn-a', 'hello', true);
  stream.started('x1', 'turn-b', 'peer words', false);
  assert.equal(out[0].human, true);
  assert.equal('human' in out[1], false);
});

test('the app reads a Host turn as a person’s only when the Host carries who wrote it: the order of a peer message and a typed one cannot swap them, and an older Host’s claim is dropped', async () => {
  const w = world();
  w.host.speaks = (f: string) => f === 'origin';
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  // a peer message's turn first (no human), then the typed one's: each turn says its own
  w.host.fire.patch(CHAT, 1, ev({ kind: 'turnStart', turnId: 'peer', user: { id: 'u1', content: [] } }));
  w.host.fire.patch(CHAT, 2, ev({ kind: 'turnEnd', turnId: 'peer', stopReason: 'end_turn' }));
  w.host.fire.patch(CHAT, 3, ev({ kind: 'turnStart', turnId: 'typed', human: true, user: { id: 'u2', content: [] } }));
  await w.chats.settled(CHAT);
  const starts = w.emitted.filter((e) => e.kind === 'turnStart');
  assert.deepEqual(
    starts.map((e) => [e.turnId, e.human]),
    [
      ['peer', undefined],
      ['typed', true],
    ],
  );
  // a Host that does not carry it (older, or hardcoding human) is read as nobody's
  const old = world();
  old.chats.follow(CHAT);
  await old.chats.settled(CHAT);
  old.host.fire.patch(CHAT, 1, ev({ kind: 'turnStart', turnId: 't', human: true, user: { id: 'u', content: [] } }));
  await old.chats.settled(CHAT);
  assert.equal(old.emitted.find((e) => e.kind === 'turnStart').human, undefined);
});

test('a continued chat’s first message carries the handoff in front, and the handoff is a prefix and the turn stays a person’s', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-origin-h-'));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const sent: any[] = [];
  const runtime: any = { host, send: async (p: any) => (sent.push(p), { turnId: 't' }), permit: () => true, familyOf: () => 'acp' };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  let handoff: any = { text: 'EARLIER', cwd: '/there' };
  const handoffs = { take: () => handoff, done: () => (handoff = null) };
  const conn = createProtocol({ runtime, epochs, guard, status: () => ({ running: true }), handoffs }).connection(() => undefined);
  await conn.call('host.hello', helloParams());
  await conn.call('chat.send', { chatId: 'c', epoch: 1, key: 'key-origin-h-0001', text: 'now', human: true });
  await conn.call('chat.send', { chatId: 'c', epoch: 1, key: 'key-origin-h-0002', text: 'next', human: true });
  assert.deepEqual(
    sent.map((p) => [p.text, p.prefix, p.human]),
    [
      ['now', 'EARLIER', true],
      ['next', undefined, true],
    ],
  );
});
