// The family a chat's stream items are tagged with (host/src/protocol.mjs, shared/host/schema.mjs `family`): an event follows its chat's harness (acp, codex, claude), and a peer that did not declare `family` is refused a chat of another family instead of reading its events as ACP's. A: tags follow the chat; W: summary items and replay keep them; B: the gate; I: a Host that restarts tags a stored chat the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { FEATURES, helloParams, requireFamily } from '../shared/host/schema.mjs';
import { base, open, refusal, until } from './support/hostCodexKit.ts';

const quiet = { report: () => undefined };

/** A protocol over a runtime that names each chat's family by its id prefix; `familyOf: false` is a runtime that does not say. */
function setup({ familyOf = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-family-'));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const calls: string[] = [];
  const runtime: any = {
    host,
    send: async (p: any) => (calls.push(`send:${p.key}`), { turnId: 't' }),
    prepare: async (p: any) => void calls.push(`prepare:${p.chatId}`),
    permit: () => true,
    ...(familyOf ? { familyOf: (id: string) => (id.startsWith('claude:') ? 'claude' : id.startsWith('acp:') ? 'acp' : 'codex') } : {}),
  };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const protocol = createProtocol({ runtime, epochs, guard, status: () => ({ running: true }) });
  const out: any[] = [];
  const conn = protocol.connection((m: object) => out.push(m));
  let n = 0;
  const call = (method: string, chatId: string, p: any = {}) => conn.call(method, { chatId, epoch: 1, key: `key-fam-${++n}-00`, ...p });
  const items = (chatId: string) => out.filter((m) => m.chatId === chatId && m.frame?.item).map((m) => m.frame.item);
  return { host, conn, call, out, items, calls, dir };
}
const text = (t: string, turnId = 't1') => ({
  kind: 'update',
  turnId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } },
});

test('A: an event is tagged with the family of the chat it belongs to, the reply summary is not', async () => {
  const s = setup();
  await s.conn.call('host.hello', helloParams());
  for (const chatId of ['acp:kimi:a', 'chat-codex', 'claude:00000000-0000-4000-8000-0000000000c1']) await s.call('chat.subscribe', chatId);
  for (const [i, chatId] of ['acp:kimi:a', 'chat-codex', 'claude:00000000-0000-4000-8000-0000000000c1'].entries()) {
    s.host.emit('event', { kind: 'turnStart', key: chatId, turnId: `t${i}` });
    s.host.emit('event', text('hi', `t${i}`));
    s.host.emit('event', { kind: 'turnEnd', turnId: `t${i}`, stopReason: 'end_turn' });
  }
  const families = (chatId: string) => [
    ...new Set(
      s
        .items(chatId)
        .filter((i) => i.t === 'event')
        .map((i) => i.family),
    ),
  ];
  assert.deepEqual(families('acp:kimi:a'), ['acp']);
  assert.deepEqual(families('chat-codex'), ['codex']);
  assert.deepEqual(families('claude:00000000-0000-4000-8000-0000000000c1'), ['claude']);
  assert.equal(s.items('chat-codex').find((i) => i.t === 'assistant').family, undefined);
});

test('A: a runtime that does not name families runs ACP chats only, and tags them so', async () => {
  const s = setup({ familyOf: false });
  await s.conn.call('host.hello', helloParams());
  await s.call('chat.subscribe', 'acp:kimi:a');
  s.host.emit('event', { kind: 'turnStart', key: 'acp:kimi:a', turnId: 't1' });
  assert.equal(s.items('acp:kimi:a')[0].family, 'acp');
  await s.call('chat.start', 'acp:kimi:b', { harness: 'acp:kimi', text: 'hi' });
});

test('B: a peer without `family` is refused a chat of another family on every chat method, and still served ACP chats', async () => {
  const s = setup();
  await s.conn.call('host.hello', { ...helloParams(), features: FEATURES.filter((f: string) => f !== 'family') });
  const gate = (e: any) => e.code === 'feature_missing' && e.missing.includes('family');
  for (const [method, chatId, extra] of [
    ['chat.subscribe', 'chat-codex', {}],
    ['chat.send', 'claude:00000000-0000-4000-8000-0000000000c1', { text: 'hi' }],
    ['chat.stop', 'chat-codex', {}],
    ['chat.answer', 'claude:00000000-0000-4000-8000-0000000000c1', { requestId: 'r' }],
    ['chat.permit', 'chat-codex', { value: 'default' }],
    ['chat.start', 'chat-codex', { harness: 'codex', text: 'hi' }],
    ['chat.start', 'claude:00000000-0000-4000-8000-0000000000c2', { harness: 'claude', text: 'hi' }],
  ] as const)
    await assert.rejects(s.call(method, chatId, extra), gate, `${method} ${chatId}`);
  assert.deepEqual(s.calls, []);
  // an ACP chat does not need the feature: an older app keeps working
  await s.call('chat.subscribe', 'acp:kimi:a');
  await s.call('chat.send', 'acp:kimi:a', { text: 'hi' });
  await s.call('chat.start', 'acp:kimi:b', { harness: 'acp:kimi', text: 'hi' });
  assert.deepEqual(s.calls, ['send:acp:kimi:a', 'send:acp:kimi:b']);
  // and with the feature a chat of another family is served
  const ok = setup();
  await ok.conn.call('host.hello', helloParams());
  await ok.call('chat.start', 'chat-codex', { harness: 'codex', text: 'hi' });
  assert.deepEqual(ok.calls, ['prepare:chat-codex', 'send:chat-codex']);
  // Claude Code's chats are minted as claude:<id>; a Codex chat may not be, and a Claude chat must be
  await ok.call('chat.start', 'claude:00000000-0000-4000-8000-0000000000c9', { harness: 'claude', text: 'hi' });
  assert.equal(ok.calls.at(-1), 'send:claude:00000000-0000-4000-8000-0000000000c9');
  for (const [chatId, harness] of [
    ['chat-x', 'claude'],
    ['claude:00000000-0000-4000-8000-0000000000c8', 'codex'],
    ['acp:kimi:z', 'codex'],
  ])
    await assert.rejects(ok.call('chat.start', chatId, { harness, text: 'hi' }), /does not belong to the harness/);
});

test('B: the family gate names what is missing, and a build declares `family`', () => {
  assert.ok(FEATURES.includes('family'));
  assert.doesNotThrow(() => requireFamily('acp', { features: [] }));
  assert.doesNotThrow(() => requireFamily('codex', { features: ['family'] }));
  assert.throws(() => requireFamily('claude', { features: [] }), /claude chat's events from ACP's/);
});

test('W/I: a Codex chat on a real Host keeps its tag in the live stream, in a replay after a reconnect, and after the Host restarts', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'fam-'));
  const first = await open(dir);
  const chatId = 'chat-family';
  try {
    await first.call('chat.subscribe', chatId);
    await first.call('chat.start', chatId, { harness: 'codex', text: 'hi', cwd: dir });
    await until(() => first.frames.some((m) => m.frame?.item?.t === 'assistant'));
    const live = first.frames.filter((m) => m.frame?.item?.t === 'event').map((m) => m.frame.item.family);
    assert.ok(live.length > 0 && live.every((f) => f === 'codex'));
    // a second connection resumes from the start: the durable tail carries the same tag
    const replay: any[] = [];
    const again = first.protocol.connection((m: any) => replay.push(m));
    await again.call('host.hello', helloParams());
    await again.call('chat.subscribe', { chatId, epoch: 1, fromRev: 0 });
    const replayed = replay.filter((m) => m.frame?.item?.t === 'event').map((m) => m.frame.item.family);
    assert.ok(replayed.length > 0 && replayed.every((f) => f === 'codex'));
  } finally {
    first.close();
  }
  const second = await open(dir);
  try {
    assert.equal(second.sessions.chatRuntime.familyOf(chatId), 'codex');
    await second.call('chat.subscribe', chatId);
    await second.call('chat.send', chatId, { text: 'again' });
    await until(() => second.frames.some((m) => m.frame?.item?.t === 'assistant'));
    assert.ok(second.frames.filter((m) => m.frame?.item?.t === 'event').every((m) => m.frame.item.family === 'codex'));
    // an old app on the restarted Host is refused the stored Codex chat
    const old = second.protocol.connection(() => undefined);
    await old.call('host.hello', { ...helloParams(), features: FEATURES.filter((f: string) => f !== 'family') });
    await assert.rejects(old.call('chat.subscribe', { chatId, epoch: 1 }), (e: any) => e.code === 'feature_missing');
    await refusal(old.call('chat.send', { chatId, epoch: 1, key: 'key-old-00001', text: 'x' }));
  } finally {
    second.close();
  }
});
