// What a read of an ACP chat's history says of itself (electron/harness/items/acp.cjs, on the real core): a transcript it can't read,
// the ids of turns with no prompt, and a held read on real timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcriptHost } from './support/acp-transcript.ts';

const require = createRequire(import.meta.url);
const { AcpItems, acpSender } = require('../electron/harness/items/acp.cjs');
const { buildAcpTurns, readChatTurns } = require('../electron/harness/items/acpTranslator.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
const { core } = require('../electron/platform/core.cjs');
const { ItemsLog } = require('../electron/platform/itemsLog.cjs');

const KEY = 'acp:kimi:s';
const session = () => new AcpItems({ chatOf: () => 'chat', nativeOf: () => KEY, cwdOf: () => '/w', emit: () => undefined });
const found =
  (...records: unknown[]) =>
  async () => ({ file: '', extra: records });
const turnsOf = async (reply: Promise<{ page: Uint8Array }>) => JSON.parse(new TextDecoder().decode((await reply).page)).turns;

test('a transcript the core cannot read says so in words, with the cause in the diagnostics', async () => {
  clearIgnored();
  const items = session();
  const folder = async () => ({ file: os.tmpdir(), extra: [] });
  await assert.rejects(items.history(KEY, 'chat', '/w', folder), /^Error: This chat's history couldn't be read\.$/);
  assert.match(recentIgnored().at(-1).message, /read an ACP transcript/);
  assert.equal(items.hearing.size, 0);
});

test("a chat's transcript says how much of it is on disk", async () => {
  const log = new ItemsLog(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-size-')));
  assert.equal(await log.size('chat'), 0);
  log.append('chat', { t: 'session' });
  await log.flush('chat');
  assert.equal(await log.size('chat'), fs.statSync(log.file('chat')).size);
  assert.ok((await log.size('chat')) > 0);
});

test('a turn with no prompt reads under one id every time', async () => {
  const items = session();
  const stray = { t: 'update', turnId: null, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'x' } } };
  const [first] = await turnsOf(items.history(KEY, 'chat', '/w', found(stray)));
  const [again] = await turnsOf(items.history(KEY, 'chat', '/w', found(stray)));
  assert.equal(first.id, again.id);
  assert.match(first.id, /^auto-/);
});

test('a read held for its next page is let go on real timers too', async () => {
  const items = session();
  const user = { id: 'u', clientId: null, content: [] };
  await items.history(KEY, 'chat', '/w', found({ t: 'user', turnId: 't', user }, { t: 'user', turnId: 'u', user }), { limit: 1 });
  assert.equal(items.held.size, 1);
  items.release(KEY);
  assert.equal(items.held.size, 0);
});

test('what a session says too deep to read again leaves a read alone, as the transcript has it', async () => {
  const items = session();
  const user = { id: 'u', clientId: null, content: [] };
  items.onEvent({ key: KEY, kind: 'turnStart', turnId: 't', user });
  // as deep as an event may be: the item it makes is deeper
  const rawInput = JSON.parse(`${'['.repeat(996)}${']'.repeat(996)}`);
  const update = { sessionUpdate: 'tool_call', toolCallId: 'c', kind: 'execute', status: 'in_progress', rawInput };
  const saying = async () => (
    items.onEvent({ key: KEY, kind: 'update', turnId: 't', update }), { file: '', extra: [{ t: 'user', turnId: 't', user }] }
  );
  const [turn] = await turnsOf(items.history(KEY, 'chat', '/w', saying, { limit: 1 }));
  assert.equal(turn.id, 't');
  items.get(KEY).close();
});

test('a read that fails after the core has it lets it go', async (t) => {
  const items = session();
  items.o.flush = () => {
    throw new Error('the batcher broke');
  };
  const dispatchSync = t.mock.method(core(), 'dispatchSync');
  await assert.rejects(items.history(KEY, 'chat', '/w', found()), /the batcher broke/);
  assert.deepEqual(
    dispatchSync.mock.calls.map((call: any) => call.arguments[0]),
    ['translate.release'],
  );
  assert.equal(items.held.size, 0);
});

const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const user = { id: 'u', clientId: null, content: [] };

test("main's own reader gets every turn, as a replay of the same records does, however many slices that takes", async () => {
  const long = 'x'.repeat(3 << 20);
  const call = (id: string) => ({ sessionUpdate: 'tool_call', toolCallId: id, status: 'completed', kind: 'execute', title: long });
  const records = [
    { t: 'session', cwd: '/named' },
    { t: 'user', turnId: 'a', user },
    ...['1', '2', '3', '4'].map((id) => ({ t: 'update', turnId: 'a', update: call(id) })),
    { t: 'end', turnId: 'a', stopReason: 'end_turn' },
    { t: 'user', turnId: 'b', user },
    { t: 'update', turnId: 'b', update: chunk('so far') },
  ];
  const host = transcriptHost(() => records);
  const open = await readChatTurns(host, KEY, 'chat', { cwd: '/here', find: true, live: true });
  assert.equal(open.cwd, '/named');
  assert.deepEqual(open.turns, buildAcpTurns(records, 'chat', '/named', { live: true }));
  const closed = await readChatTurns(host, KEY, 'chat', { cwd: '/here' });
  assert.deepEqual(closed.turns, buildAcpTurns(records, 'chat', '/here'));
  assert.equal(closed.turns.at(-1).status, 'interrupted');
});

test('a transcript that names no folder asks where to read it, and one with no turns has none', async () => {
  const records = [
    { t: 'user', turnId: 'a', user },
    { t: 'update', turnId: 'a', update: { sessionUpdate: 'tool_call', toolCallId: 'c', kind: 'execute' } },
  ];
  const host = transcriptHost(() => records);
  const { turns, cwd } = await readChatTurns(host, KEY, 'chat', { find: true, otherwise: async () => '/asked', live: true });
  assert.deepEqual([cwd, turns[0].items[1].cwd], ['/asked', '/asked']);
  assert.equal((await readChatTurns(host, KEY, 'chat', { find: true, otherwise: async () => null, live: true })).cwd, '');
  assert.deepEqual(
    (
      await readChatTurns(
        transcriptHost(() => []),
        KEY,
        'chat',
      )
    ).turns,
    [],
  );
});

test('what a session says while its turn is followed from its transcript waits for it, in order', async () => {
  const sent: string[] = [];
  const windows = (channel: string, event: any) => (
    sent.push(`${channel}:${event.method ?? event.kind}:${event.params?.item?.id ?? ''}`), true
  );
  const live = { controller: { chatOf: () => 'chat', nativeOf: () => KEY } };
  const { send, items } = acpSender(live, windows);
  const written = [
    { t: 'user', turnId: 't', user },
    { t: 'update', turnId: 't', update: chunk('written ') },
  ];
  send({ key: KEY, kind: 'turnStart', turnId: 't', user, partway: { file: '', extra: written } });
  assert.equal(items.following.has(KEY), true);
  assert.equal(
    send({
      key: KEY,
      kind: 'update',
      turnId: 't',
      update: { sessionUpdate: 'tool_call', toolCallId: 'c', kind: 'execute', status: 'in_progress' },
    }),
    true,
  );
  assert.equal(send({ key: 'acp:kimi:other', kind: 'session' }), true);
  send({ key: KEY, kind: 'turnEnd', turnId: 't', stopReason: 'end_turn' });
  // nothing of it has gone yet but the turn's start and the other session's event
  assert.equal(sent.filter((line) => line.includes('turnEnd')).length, 0);
  await items.followed;
  assert.equal(items.following.size, 0);
  const after = sent.slice(sent.findIndex((line) => line.startsWith('acp:event:turnStart')));
  assert.deepEqual(after, [
    'acp:event:turnStart:',
    'acp:event:session:',
    'acp:items:item/completed:t:m0',
    'acp:items:item/started:c',
    'acp:event:update:',
    'acp:items:item/completed:c',
    'acp:items:turn/completed:',
    'acp:event:turnEnd:',
  ]);
  items.get(KEY).close();
});

test('a window asks a chat being followed from its transcript after what waits for it has gone on', async () => {
  const seen: string[] = [];
  const { send, items } = acpSender(
    { controller: { chatOf: () => 'chat', nativeOf: () => KEY } },
    (channel: string, e: any) => (seen.push(e.kind ?? e.method), true),
  );
  send({ key: KEY, kind: 'turnStart', turnId: 't', user, partway: { file: '', extra: [{ t: 'user', turnId: 't', user }] } });
  send({ key: KEY, kind: 'update', turnId: 't', update: chunk('late') });
  const read = async () => (seen.push('read'), { file: '', extra: [] });
  const page = items.history(KEY, 'chat', '/w', read);
  // and one that throws takes nothing with it
  items.following.get(KEY).unshift(() => {
    throw new Error('a window went');
  });
  await items.followed;
  await page;
  assert.ok(seen.indexOf('update') < seen.indexOf('read'));
  items.get(KEY).close();
});

test("a turn that's over by the transcript keeps the translator that began it, and so does one that can't be read", async () => {
  clearIgnored();
  const items = session();
  const ended = [
    { t: 'user', turnId: 't', user },
    { t: 'end', turnId: 't', stopReason: 'end_turn' },
  ];
  items.onEvent({ key: KEY, kind: 'turnStart', turnId: 't', user, partway: { file: '', extra: ended } });
  const own = items.get(KEY);
  await items.followed;
  assert.equal(items.get(KEY), own);
  items.onEvent({ key: KEY, kind: 'turnEnd', turnId: 't', stopReason: 'end_turn' });
  items.onEvent({ key: KEY, kind: 'turnStart', turnId: 'u', user, partway: { file: os.tmpdir(), extra: [] } });
  await items.followed;
  assert.equal(items.get(KEY), own);
  assert.equal(items.following.size, 0);
  assert.match(recentIgnored().at(-1).context, /follow a turn/);
  own.close();
});
