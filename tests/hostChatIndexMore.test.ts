// The Host's chat index (#5576), part two: who may see which chats and names, a client that pages while chats change, the cost of a busy chat, a failed build, back-pressure, watches that replace one another and what survives a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createChatIndex } from '../host/src/chatIndex.mjs';
// @ts-ignore
import { createChatLog } from '../host/src/chatLog.mjs';
// @ts-ignore
import chatsMethods from '../host/src/methods/chats.mjs';
// @ts-ignore
import { chatScopeOf } from '../host/src/chatScope.mjs';
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

const who = (kind: string, fingerprint: string) => ({ principal: () => ({ kind, fingerprint, name: `${kind} ${fingerprint}` }) });

test('who may list and watch: a desktop, phone or CLI sees every chat the veil leaves, a client of any other kind (MoMo’s `home`) only the chats it started, and a device name only where the client may already read names', async () => {
  const { index } = made([]);
  await index.ready();
  const start = (id: string, by: string, fp: string) => index.observe(id, { t: 'state', patch: { origin: { by, fp } } });
  start('mine', 'Work Mac', 'fp-desk');
  start('theirs', 'Phone', 'fp-phone');
  start('home-own', 'Home', 'fp-home');
  start('veiled', 'Work Mac', 'fp-desk');
  const veil = (_who: unknown) => (id: string) => id !== 'veiled';
  const seen = async (w: any) => {
    const page = await index.page({ limit: 10 }, chatScopeOf(veil)(w));
    return Object.fromEntries(page.chats.map((c: any) => [c.chatId, c.startedBy ?? null]));
  };
  assert.deepEqual(await seen(who('desktop', 'fp-desk')), { mine: 'Work Mac', theirs: 'Phone', 'home-own': 'Home' });
  assert.deepEqual(await seen(who('cli', 'fp-cli')), { mine: 'Work Mac', theirs: 'Phone', 'home-own': 'Home' });
  assert.deepEqual(
    await seen(who('phone', 'fp-phone')),
    { mine: null, theirs: 'Phone', 'home-own': null },
    'a phone reads only its own name',
  );
  assert.deepEqual(
    await seen(who('home', 'fp-home')),
    { 'home-own': 'Home' },
    'a kind that is not named sees what it started and nothing else',
  );
  assert.deepEqual(await seen(who('future-kind', 'fp-x')), {});
  assert.deepEqual(await seen(who('home', '')), {}, 'a client with no key it is known by owns nothing');
  assert.deepEqual(Object.keys(await seen({})).length, 3, 'an embedder with no pairing is served as it was, the veil still applies');
  // events follow the same scope, and a key is never on the wire
  const heard: any[] = [];
  index.watch((e: any) => heard.push(e), chatScopeOf(veil)(who('home', 'fp-home')));
  start('late-theirs', 'Phone', 'fp-phone');
  start('late-own', 'Home', 'fp-home');
  index.observe('late-own', { t: 'removed' });
  index.observe('late-theirs', { t: 'removed' });
  assert.deepEqual(
    heard.map((e) => [e.chatId, e.op]),
    [
      ['late-own', 'upsert'],
      ['late-own', 'remove'],
    ],
  );
  assert.ok(!JSON.stringify(heard).includes('fp-'), 'no key on the wire');
  const raw = (await index.page({ limit: 10 })).chats[0];
  assert.equal('byFp' in raw, false);
});

test('a client that pages while chats change loses and doubles nothing when it de-dupes by chatId and applies every event, including one for a chat it has not paged to', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => summary(`c${String(i).padStart(2, '0')}`, 100 - i));
  const { index } = made(rows);
  await index.ready();
  // the client's model of the adoption order: watch first, buffer, page to the end, apply events newer than the first page's `at`
  const buffered: any[] = [];
  index.watch((e: any) => buffered.push(e));
  const known = new Map<string, any>();
  let cursor: string | undefined;
  let firstAt: number | undefined;
  let pages = 0;
  do {
    const page = await index.page({ limit: 3, cursor });
    firstAt ??= page.at;
    for (const c of page.chats) known.set(c.chatId, c);
    cursor = page.next;
    pages++;
    // between pages: a chat already paged moves to the top, one not yet paged moves too, a new one begins, one is removed
    if (pages === 1) {
      index.observe('c00', turn('turnStart'));
      index.observe('c10', turn('turnStart'));
      index.observe('fresh', { t: 'durable', item: { t: 'user' } });
      index.observe('c08', { t: 'removed' });
    }
  } while (cursor);
  for (const e of buffered.filter((e) => e.seq > firstAt!)) e.op === 'remove' ? known.delete(e.chatId) : known.set(e.chatId, e.chat);
  const expected = (await index.page({ limit: 50 })).chats.map((c: any) => c.chatId).sort();
  assert.deepEqual([...known.keys()].sort(), expected, 'the client ends with exactly the Host’s list');
  assert.equal(known.get('c10').state, 'running', 'a chat it had not paged to is still applied from its event');
  assert.ok(pages >= 3);
});

test('a busy chat costs a few events, not one per token or tool call: a row tells only a turn start, a turn end, attention, a rename or a removal', async () => {
  const { index } = made([]);
  await index.ready();
  const told: any[] = [];
  index.watch((e: any) => told.push(e));
  index.observe('busy', turn('turnStart'));
  for (let i = 0; i < 1000; i++)
    index.observe('busy', { t: 'durable', item: { t: 'event', event: { kind: 'update', update: { sessionUpdate: 'tool_call' } } } });
  for (let i = 0; i < 200; i++) index.observe('busy', { t: 'state', patch: { tasks: [i], goal: `g${i}` } });
  index.observe('busy', turn('turnEnd'));
  assert.deepEqual(
    told.map((e) => e.kind),
    ['created', 'turnEnded'],
    'two events for a turn however much happens in it',
  );
});

test('a build that failed leaves an incomplete list and is tried again by the next one; an owner that moved changes the row and its revision', async () => {
  let fail = true;
  const reports: string[] = [];
  const index = createChatIndex({
    load: async () => {
      if (fail) throw new Error('disk busy');
      return [summary('saved', 5)];
    },
    epoch: () => 3,
    report: (m: string) => reports.push(m),
  });
  index.observe('early', { t: 'durable', item: { t: 'user' } });
  const first = await index.page({ limit: 10 });
  assert.deepEqual(
    first.chats.map((c: any) => c.chatId),
    ['early'],
  );
  assert.equal(first.incomplete, true, 'a partial list says so');
  assert.equal(index.complete, false);
  fail = false;
  const second = await index.page({ limit: 10 });
  assert.deepEqual(second.chats.map((c: any) => c.chatId).sort(), ['early', 'saved']);
  assert.equal('incomplete' in second, false);
  assert.ok(reports.some((m) => /could not be built: Error: disk busy/.test(m)));
  const told: any[] = [];
  index.watch((e: any) => told.push(e));
  const before = (await index.page({ limit: 10 })).chats.find((c: any) => c.chatId === 'saved')?.rev;
  index.observe('saved', { t: 'epoch' });
  index.observe('unknown', { t: 'epoch' });
  assert.deepEqual(
    told.map((e) => [e.chatId, e.kind, e.rev, e.chat.epoch]),
    [['saved', 'changed', (before ?? 0) + 1, 3]],
    'a chat the Host does not list is not made by an epoch',
  );
});

test('a connection that is behind is told once to list again, and hears nothing else until it took that; events carry the Host’s generation and the chat’s revision', async () => {
  const { index } = made([]);
  await index.ready();
  let behind = true;
  const got: any[] = [];
  const w = index.watch((e: any) => (got.push(e), !behind));
  index.observe('a', { t: 'durable', item: { t: 'user' } });
  assert.equal(got.length, 1);
  index.observe('a', turn('turnStart'));
  index.observe('a', turn('turnEnd'));
  assert.deepEqual(
    got.map((e) => e.op),
    ['upsert', 'resync', 'resync'],
    'while it stays behind only the resync is tried again, nothing piles up',
  );
  behind = false;
  index.observe('a', turn('turnStart'));
  assert.deepEqual(got.map((e) => e.op).slice(3), ['resync']);
  index.observe('a', turn('turnEnd'));
  assert.deepEqual(got.map((e) => e.op).slice(4), ['upsert']);
  assert.ok(got.every((e) => e.generation === index.generation));
  assert.equal(got[4].rev > got[0].rev, true);
  assert.equal(w.seq(), got.length);
});

test('a page does not look at every row: only from the cursor on, until it is full', async () => {
  const rows = Array.from({ length: 500 }, (_, i) => summary(`c${String(i).padStart(3, '0')}`, 1000 - i));
  const { index } = made(rows);
  let asked = 0;
  const scope = { sees: () => (asked++, true), names: () => true };
  const page = await index.page({ limit: 5 }, scope);
  assert.equal(page.chats.length, 5);
  assert.ok(asked <= 6, `looked at ${asked} rows`);
  const second = await index.page({ limit: 5, cursor: page.next }, scope);
  assert.deepEqual(
    second.chats.map((c: any) => c.chatId),
    ['c005', 'c006', 'c007', 'c008', 'c009'],
  );
});

test('a second watch of one connection takes the first one’s place in what ends with the connection, and numbers the list that connection reads', async (t) => {
  const log = createChatLog({ dataDir: tmp(t), epoch: () => 1 });
  const methods: any = chatsMethods({ dataDir: '/data', log, epochs: { current: () => 1 } } as any);
  const ends = new Set<() => void>();
  const heard: number[] = [];
  for (let i = 0; i < 3; i++) await methods.handlers['host.chats.watch']({}, 'desktop', {}, () => heard.push(i), ends);
  assert.equal(ends.size, 1);
  log.index.observe('x', { t: 'durable', item: { t: 'user' } });
  assert.deepEqual(heard, [2], 'only the last watch hears');
  const listed = await methods.handlers['host.chats']({ limit: 5 }, 'desktop', {}, () => undefined, ends);
  assert.equal(listed.at, 1);
  assert.equal(
    (await methods.handlers['host.chats']({ limit: 5 }, 'desktop', {}, () => undefined, new Set())).at,
    0,
    'a connection with no watch is at 0',
  );
  for (const end of ends) end();
});

test('what still holds after a restart (a paused chat) comes back as attention, a card does not, and the starter’s name is kept to 80 characters', async (t) => {
  const data = tmp(t);
  const log = createChatLog({ dataDir: data, epoch: () => 1 });
  log.hub.state('claude:paused', { attention: { kind: 'paused', since: 1 }, origin: { by: 'N'.repeat(300) } });
  log.hub.state('claude:card', { attention: { kind: 'approval', since: 1, cards: ['r'] } });
  log.finish('claude:paused', { t: 'user', text: 'hi' });
  log.finish('claude:card', { t: 'user', text: 'hi' });
  const again = createChatLog({ dataDir: data, epoch: () => 1 });
  const rows = Object.fromEntries((await again.index.page({ limit: 10 })).chats.map((c: any) => [c.chatId, c]));
  assert.equal(rows['claude:paused'].state, 'attention');
  assert.equal(rows['claude:card'].state, 'idle', 'a card is closed by a restart');
  const first = createChatLog({ dataDir: data, epoch: () => 1 });
  assert.ok((await first.index.page({ limit: 10 })).chats.every((c: any) => !c.startedBy || c.startedBy.length <= 80));
});

test('what a state patch calls attention: a kind, a bare kind, or nothing; a title with no name falls back to nothing', async () => {
  const { attentionKind } = await import('../host/src/chatIndex.mjs');
  assert.deepEqual(
    [
      attentionKind('paused'),
      attentionKind({ kind: 'approval', since: 1 }),
      attentionKind(''),
      attentionKind(null),
      attentionKind({}),
      attentionKind({ kind: 5 }),
      attentionKind(7),
    ],
    ['paused', 'approval', null, null, null, null, null],
  );
  const { index } = made([]);
  await index.ready();
  index.observe('t', { t: 'state', patch: { title: { name: '', provisional: null } } });
  assert.equal((await index.page({ limit: 5 })).chats[0].title, '');
  index.observe('t', { t: 'state', patch: { title: { name: '', provisional: 'first words' } } });
  assert.equal((await index.page({ limit: 5 })).chats[0].title, 'first words');
});

test('the list says where the next page is and that it is incomplete, through the handler’s own list', async () => {
  const { chatListOf } = await import('../host/src/chatList.mjs');
  let fail = true;
  const log = {
    chats: async () => {
      if (fail) throw new Error('disk busy');
      return [summary('a', 3), summary('b', 2), summary('c', 1)];
    },
    fillTitle: () => ({ status: 'deferred' }),
  };
  const list = chatListOf(log as any, { current: () => 1 } as any);
  const partial = await list({ limit: 2 }, undefined);
  assert.equal(partial.incomplete, true);
  fail = false;
  const whole = await list({ limit: 2 }, undefined);
  assert.deepEqual([whole.chats.length, typeof whole.next, 'incomplete' in whole], [2, 'string', false]);
  assert.equal((await list({ limit: 2, cursor: whole.next }, undefined)).next, undefined);
});

test('a summary file whose origin, starter key or attention is not text is not believed, and a chat started by a key lists with it', async (t) => {
  const data = tmp(t);
  const log = createChatLog({ dataDir: data, epoch: () => 1 });
  log.hub.state('claude:keyed', { origin: { folder: '/w', by: 'Mac', fp: 'fp-1' } });
  log.finish('claude:keyed', { t: 'user', text: 'hi' });
  const again = createChatLog({ dataDir: data, epoch: () => 1 });
  const scope = { sees: (_id: string, row?: { byFp?: string }) => row?.byFp === 'fp-1', names: () => true };
  assert.deepEqual(
    (await again.index.page({ limit: 5 }, scope)).chats.map((c: any) => c.chatId),
    ['claude:keyed'],
    'the key survives a restart',
  );
  const crypto = await import('node:crypto');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.join(data, 'sessions', crypto.createHash('sha256').update('claude:keyed').digest('hex'));
  const line = (v: object) => {
    const text = JSON.stringify(v);
    return `${crypto.createHash('sha256').update(text).digest('hex')} ${text}\n`;
  };
  for (const bad of [{ folder: 5 }, { by: 5 }, { fp: 5 }, { attn: 5 }]) {
    fs.writeFileSync(path.join(dir, 'summary'), line({ v: 1, chatId: 'claude:keyed', createdAt: 1, title: 't', ...bad }));
    const listed = await createChatLog({ dataDir: data, epoch: () => 1 }).index.page({ limit: 5 });
    assert.equal(listed.chats[0]?.title ?? '', '', `a summary with ${Object.keys(bad)[0]} that is not text is a stand-in, not a title`);
  }
});
