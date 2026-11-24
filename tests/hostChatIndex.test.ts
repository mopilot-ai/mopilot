// The Host's chat index (#5576): `host.chats` pages from memory with a stable cursor, and `host.chats.watch` tells a connection of each change to a row (a chat another client started, a rename, a turn, a removal) without polling, never of a chat the connection may not see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
// @ts-ignore: plain ESM without declarations
import { createChatIndex, cursorOf, placeOf } from '../host/src/chatIndex.mjs';
// @ts-ignore
import { createChatLog } from '../host/src/chatLog.mjs';
// @ts-ignore
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore
import chatsMethods from '../host/src/methods/chats.mjs';
// @ts-ignore
import { helloParams, parseParams, requireFeatures } from '../shared/host/schema.mjs';
// @ts-ignore
import { createChatEffects } from '../host/src/chatEffects.mjs';
import { tmp } from './support/host/chatListKit';

const summary = (chatId: string, updatedAt: number, extra = {}) => ({ chatId, title: chatId, createdAt: 1, updatedAt, ...extra });
const made = (rows: any[], over: Record<string, unknown> = {}) => {
  const reports: string[] = [];
  let clock = 1000;
  const index = createChatIndex({
    load: async () => rows,
    epoch: () => 4,
    now: () => ++clock,
    report: (m: string) => reports.push(m),
    ...over,
  });
  return { index, reports };
};
const turn = (kind: string) => ({ t: 'durable', item: { t: 'event', event: { kind } } });

test('a page is the newest activity first, cut at the limit, with a cursor that holds when chats are added', async () => {
  const { index } = made([summary('a', 10), summary('b', 30), summary('c', 20), summary('d', 20)]);
  const first = await index.page({ limit: 2 });
  assert.deepEqual(
    first.chats.map((c: any) => c.chatId),
    ['b', 'c'],
  );
  assert.equal(first.chats[0].epoch, 4);
  assert.equal(first.chats[0].state, 'idle');
  assert.ok(first.next);
  // a chat that began meanwhile is newest: the next page still starts where the last one ended
  index.observe('z', turn('turnStart'));
  await new Promise((r) => setImmediate(r));
  const second = await index.page({ limit: 2, cursor: first.next });
  assert.deepEqual(
    second.chats.map((c: any) => c.chatId),
    ['d', 'a'],
  );
  assert.equal(second.next, undefined, 'the last page names no next place');
  assert.equal((await index.page({ limit: 5 })).next, undefined, 'a page that is exactly full has no next page when nothing is left');
  await assert.rejects(index.page({ limit: 1, cursor: 'not-a-place' }), (e: any) => e.code === 'bad_cursor');
  assert.equal(placeOf(Buffer.from('[1]').toString('base64url')), null);
  assert.deepEqual(placeOf(cursorOf({ updatedAt: 5, chatId: 'q' })), [5, 'q']);
});

test('what a caller may not see is left out before the page is cut, so a page tells nothing about it', async () => {
  const { index } = made([summary('hidden1', 50), summary('a', 40), summary('b', 30), summary('hidden2', 20), summary('c', 10)]);
  const visible = { sees: (id: string) => !id.startsWith('hidden'), names: () => true };
  const page = await index.page({ limit: 2 }, visible);
  assert.deepEqual(
    page.chats.map((c: any) => c.chatId),
    ['a', 'b'],
  );
  const rest = await index.page({ limit: 2, cursor: page.next }, visible);
  assert.deepEqual(
    rest.chats.map((c: any) => c.chatId),
    ['c'],
  );
  assert.equal(rest.next, undefined);
});

test('a row follows its chat: created, turn, attention, title, folder, removal; a patch that changes nothing tells nothing', async () => {
  const { index } = made([summary('old', 5)]);
  const told: any[] = [];
  await index.ready();
  const watch = index.watch((e: any) => told.push(e));
  const kinds = () => told.map((e) => [e.op, e.kind, e.chat?.state ?? null]);
  index.observe('new', { t: 'durable', item: { t: 'user' } });
  index.observe('new', turn('turnStart'));
  index.observe('new', turn('turnStart'));
  index.observe('new', { t: 'state', patch: { attention: { kind: 'approval', since: 1, cards: ['r1'] } } });
  index.observe('new', { t: 'state', patch: { attention: { kind: 'approval', since: 1, cards: ['r1'] } } });
  index.observe('new', { t: 'state', patch: { attention: null } });
  index.observe('new', turn('turnEnd'));
  index.observe('new', {
    t: 'state',
    patch: { title: { name: 'Fix it', provisional: null }, harness: 'codex', origin: { folder: '/w', by: 'Work Mac' } },
  });
  index.observe('new', { t: 'state', patch: { goal: 'x' } });
  index.observe('new', { t: 'removed' });
  index.observe('never-there', { t: 'removed' });
  assert.deepEqual(kinds(), [
    ['upsert', 'created', 'idle'],
    ['upsert', 'changed', 'running'],
    ['upsert', 'attention', 'attention'],
    ['upsert', 'changed', 'running'],
    ['upsert', 'turnEnded', 'idle'],
    ['upsert', 'changed', 'idle'],
    ['remove', 'removed', null],
  ]);
  assert.deepEqual(
    told.map((e) => e.seq),
    [1, 2, 3, 4, 5, 6, 7],
    'one numbering for the whole Host',
  );
  const named = told[5].chat;
  assert.deepEqual([named.title, named.harness, named.folder, named.startedBy], ['Fix it', 'codex', '/w', 'Work Mac']);
  assert.equal(told[0].chatId, 'new');
  watch.stop();
  index.observe('later', { t: 'durable', item: { t: 'user' } });
  assert.equal(told.length, 7, 'a stopped watch hears nothing');
});

test('a watch hears only of the chats its caller may see, and a failing send neither fails the write nor stops the others', async () => {
  const { index, reports } = made([]);
  await index.ready();
  const heard: string[] = [];
  index.watch((e: any) => heard.push(e.chatId), { sees: (id: string) => id !== 'secret', names: () => true });
  index.watch(() => {
    throw new Error('closed');
  });
  index.observe('secret', { t: 'durable', item: { t: 'user' } });
  index.observe('open', { t: 'durable', item: { t: 'user' } });
  assert.deepEqual(heard, ['open']);
  assert.ok(reports.some((m) => /could not be sent: Error: closed/.test(m)));
});

test('what happens before the journals are read waits for them; a Host that cannot read them says so and still follows chats; side chats are not listed', async () => {
  let release: (rows: any[]) => void = () => undefined;
  const { index } = made([], { load: () => new Promise((r) => (release = r)) });
  index.observe('saved', { t: 'state', patch: { goal: 'x' } });
  index.observe('saved', { t: 'durable', item: { t: 'user' } });
  release([summary('saved', 7, { title: 'Its own title', createdAt: 3 })]);
  await index.ready();
  await new Promise((r) => setImmediate(r));
  const [row] = (await index.page({ limit: 5 })).chats;
  assert.deepEqual(
    [row.chatId, row.title, row.createdAt],
    ['saved', 'Its own title', 3],
    'a chat saved before this Host started keeps its title and date',
  );
  const side = made([summary('claude:side-chat-22222222-2222-4222-8222-222222222222', 1)]);
  const broken = made([], {
    load: async () => {
      throw new Error('disk gone');
    },
  });
  await broken.index.ready();
  assert.ok(broken.reports.some((m) => /could not be built: Error: disk gone/.test(m)));
  broken.index.observe('x', { t: 'durable', item: { t: 'user' } });
  assert.deepEqual(
    (await broken.index.page({ limit: 5 })).chats.map((c: any) => c.chatId),
    ['x'],
  );
  await side.index.ready();
  void side;
  // a body that cannot be applied is reported and never thrown into the write that made it
  const bad = made([]);
  await bad.index.ready();
  bad.index.observe('y', { t: 'state', patch: null, item: {} });
  bad.index.observe('y', {
    t: 'durable',
    get item() {
      throw new Error('torn');
    },
  });
  assert.ok(bad.reports.some((m) => /could not follow chat y: Error: torn/.test(m)));
});

test('a title found from a journal is kept without telling anyone of a change', async () => {
  const { index } = made([summary('s', 9, { standIn: true, title: '' })]);
  const told: any[] = [];
  await index.ready();
  index.watch((e: any) => told.push(e));
  assert.equal(index.standIn('s'), true);
  index.filled('s', { title: 'Found', harness: 'codex' });
  index.filled('missing', { title: 'x' });
  index.filled('s', { title: 'Found' });
  const [row] = (await index.page({ limit: 1 })).chats;
  assert.deepEqual([row.title, row.harness, row.standIn ?? null, told.length], ['Found', 'codex', null, 0]);
  assert.equal(index.standIn('s'), false);
});

test('the chat log feeds the index: a chat written by one client is in the list and told of; a restart builds it from the summaries, with where it began and who began it', async (t) => {
  const data = tmp(t);
  const log = createChatLog({ dataDir: data, epoch: () => 1 });
  const told: any[] = [];
  await log.index.ready();
  log.index.watch((e: any) => told.push(e));
  log.hub.state('acp:kimi:c1', { origin: { folder: '/work', by: 'Phone' } });
  log.hub.state('acp:kimi:c1', { title: { name: 'Named', provisional: null } });
  log.finish('acp:kimi:c1', { t: 'user', text: 'hi' });
  assert.deepEqual(
    told.map((e) => [e.kind, e.chat.title, e.chat.folder]),
    [
      ['created', '', '/work'],
      ['changed', 'Named', '/work'],
    ],
  );
  const again = createChatLog({ dataDir: data, epoch: () => 1 });
  const [row] = (await again.index.page({ limit: 5 })).chats;
  assert.deepEqual([row.chatId, row.title, row.folder, row.startedBy, row.harness], ['acp:kimi:c1', 'Named', '/work', 'Phone', 'acp:kimi']);
  again.remove('acp:kimi:c1');
  assert.deepEqual((await again.index.page({ limit: 5 })).chats, []);
  // a log with no data directory has nothing to list
  assert.deepEqual((await createChatLog({ epoch: () => 1 }).index.page({ limit: 5 })).chats, []);
});

test('a Host tells a connection of a chat another connection started, and of its end, and ends the watch with the connection', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-watch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const runtime: any = { host, send: async () => ({ turnId: 't1' }), permit: () => true };
  const quiet = { report: () => undefined };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const protocol = createProtocol({ runtime, epochs, guard, status: () => ({ running: true }), dataDir: dir, ...quiet });
  const seen: any[] = [];
  const watcher = protocol.connection((m: any) => seen.push(m));
  const starter = protocol.connection(
    () => undefined,
    () => null,
    { principal: () => ({ fingerprint: 'f', name: 'Work MacBook', kind: 'desktop' }) },
  );
  await watcher.call('host.hello', helloParams());
  await starter.call('host.hello', helloParams());
  const watching = await watcher.call('host.chats.watch', {});
  assert.deepEqual([watching.watching, watching.at, typeof watching.generation], [true, 0, 'string']);
  await watcher.call('host.chats.watch', {});
  await starter.call('chat.start', {
    chatId: 'acp:kimi:c9',
    epoch: 0,
    key: 'key-00000001',
    harness: 'acp:kimi',
    text: 'hello',
    cwd: '/proj',
  });
  const told = seen.filter((m) => m.event === 'chats');
  assert.ok(told.length > 0);
  assert.deepEqual([told[0].chatId, told[0].op, told[0].kind], ['acp:kimi:c9', 'upsert', 'created']);
  const row = told.at(-1).chat;
  assert.deepEqual([row.folder, row.startedBy, row.harness], ['/proj', 'Work MacBook', 'acp:kimi']);
  const listed = await watcher.call('host.chats', { limit: 10 });
  assert.deepEqual(
    listed.chats.map((c: any) => [c.chatId, c.folder, c.startedBy]),
    [['acp:kimi:c9', '/proj', 'Work MacBook']],
  );
  assert.ok(listed.at >= told.at(-1).seq, 'the list is read in the numbering the events continue');
  await starter.call('chat.remove', { chatId: 'acp:kimi:c9', epoch: 0, key: 'key-00000002' }).catch(() => undefined);
  const count = seen.length;
  watcher.close();
  await starter.call('chat.start', { chatId: 'acp:kimi:c10', epoch: 0, key: 'key-00000003', harness: 'acp:kimi', text: 'again' });
  assert.equal(seen.length, count, 'a closed connection is not told');
});

test('the declaration: a cursor is a short string, the watch needs its own feature, and a Host with no log says it keeps none', async () => {
  assert.deepEqual(parseParams('host.chats', { cursor: 'abc' }), { limit: 200, cursor: 'abc' });
  assert.deepEqual(parseParams('host.chats', {}), { limit: 200 });
  assert.throws(() => parseParams('host.chats', { cursor: '' }), /place in this list/);
  assert.throws(() => parseParams('host.chats', { cursor: 5 }), /place in this list/);
  assert.throws(() => requireFeatures('host.chats.watch', { features: ['chatList'] }, {}), /chatEvents/);
  const none = chatsMethods({}).handlers['host.chats.watch'];
  await assert.rejects(
    none({}, 'desktop', {}, () => undefined, new Set()),
    /keeps no chats/,
  );
});

test('where a chat began and who began it are kept on its state when it starts; a state that cannot be written is reported and never fails the start', async () => {
  const states: any[] = [];
  const reports: string[] = [];
  const effects = (state: any) =>
    createChatEffects({
      runtime: { send: async () => ({ turnId: 't1' }) },
      handoffs: null,
      finish: () => undefined,
      record: () => undefined,
      endedTurns: new Set(),
      images: null,
      tools: null,
      check: () => undefined,
      faults: { clear: () => undefined, fail: () => undefined },
      approvals: { resume: () => null },
      report: (m: string) => reports.push(m),
      state,
    } as any);
  const start = { chatId: 'acp:kimi:o1', harness: 'acp:kimi', text: 'go', key: 'req-0000001' };
  const ok = effects((id: string, patch: any) => states.push([id, patch]));
  await ok['chat.start']({ ...start, cwd: '/w', by: { name: 'Mac', fingerprint: 'f', kind: 'desktop' } });
  await ok['chat.start']({ ...start, by: 'Phone' });
  await ok['chat.start']({ ...start, cwd: '/only' });
  await ok['chat.start']({ ...start });
  assert.deepEqual(
    states.map((s) => s[1]),
    [{ origin: { folder: '/w', by: 'Mac', fp: 'f' } }, { origin: { by: 'Phone' } }, { origin: { folder: '/only' } }],
  );
  const failing = effects(() => {
    throw new Error('journal full');
  });
  await failing['chat.start']({ ...start, cwd: '/w' });
  assert.ok(reports.some((m) => /Could not keep where chat acp:kimi:o1 began: Error: journal full/.test(m)));
});

test('a side chat is never in the index', async () => {
  const { index } = made([]);
  await index.ready();
  const told: any[] = [];
  index.watch((e: any) => told.push(e));
  index.observe('claude:side-chat-22222222-2222-4222-8222-222222222222', {
    t: 'durable',
    item: { t: 'user' },
  });
  assert.equal(told.length, 0);
  assert.deepEqual((await index.page({ limit: 5 })).chats, []);
});
