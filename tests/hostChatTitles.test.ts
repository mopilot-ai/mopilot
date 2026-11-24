// The titles `host.chats` finds for chats that have only a stand-in summary (#4884): the newest first and a few a call, counted when left or impossible, never for a deleted chat or one the caller may not see, and never a blank title written for a read that failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSessionJournal } from '../host/src/sessionJournal.mjs';
import { chatListOf } from '../host/src/chatList.mjs';
import { dirOf, fsWith, tmp, touch, write } from './support/host/chatListKit';

/** Chats a Host from before summaries wrote: a title in their journal and no summary file. */
const standIns = (j: any, data: string, ids: string[], title: (id: string) => string = (id) => `Title ${id}`) => {
  for (const id of ids) {
    write(j, id);
    j.state(id, { title: { name: title(id), provisional: null } });
    fs.rmSync(path.join(dirOf(data, id), 'summary'));
  }
};
const logOf = (j: any, fill?: (id: string, real: () => any) => any) => ({
  chats: () => j.chats(),
  fillTitle: (id: string, budget?: number) => (fill ? fill(id, () => j.fillTitle(id, budget)) : j.fillTitle(id, budget)),
});
const epochs = { current: () => 1 };
const summaryOf = (data: string, id: string) => fs.readFileSync(path.join(dirOf(data, id), 'summary'), 'utf8');

test('the newest stand-ins get their titles first, ten a call, and the answer says how many are left; the titles are written as real summaries', async (t) => {
  const data = tmp(t);
  const ids = Array.from({ length: 12 }, (_, i) => `claude:c${i}`);
  standIns(createSessionJournal({ dataDir: data }), data, ids);
  ids.forEach((id, i) => touch(path.join(dirOf(data, id), 'events'), i * 1000));
  const list = chatListOf(logOf(createSessionJournal({ dataDir: data })), epochs);
  const first = await list({ limit: 200 }, undefined);
  assert.deepEqual(first.titles, { pending: 2, deferred: 0 });
  assert.deepEqual(
    first.chats.map((c: any) => [c.chatId, c.title]).slice(0, 3),
    [
      ['claude:c11', 'Title claude:c11'],
      ['claude:c10', 'Title claude:c10'],
      ['claude:c9', 'Title claude:c9'],
    ],
    'newest first',
  );
  assert.deepEqual(
    first.chats.slice(-2).map((c: any) => c.title),
    ['', ''],
    'the oldest two wait for the next call',
  );
  assert.ok(
    first.chats.every((c: any) => !('standIn' in c)),
    'the flag is the Host’s own and is not on the wire',
  );
  assert.doesNotMatch(summaryOf(data, 'claude:c11'), /provisional/);
  assert.match(summaryOf(data, 'claude:c0'), /"provisional":true/);
  const second = await list({ limit: 200 }, undefined);
  assert.deepEqual(second.titles, { pending: 0, deferred: 0 });
  assert.equal(
    second.chats.every((c: any) => c.title.startsWith('Title ')),
    true,
  );
  // a chat that really has no title is made real with an empty one, and is not looked at again
  const idle = createSessionJournal({ dataDir: data });
  write(idle, 'claude:untitled');
  fs.rmSync(path.join(dirOf(data, 'claude:untitled'), 'summary'));
  const reads = { n: 0 };
  const watched = createSessionJournal({
    dataDir: data,
    io: fsWith({
      readFileSync: (real: any, f: string, ...rest: unknown[]) => (
        String(f).includes(path.basename(dirOf(data, 'claude:untitled'))) && String(f).endsWith('checkpoint') && reads.n++, real(f, ...rest)
      ),
    }),
  });
  await chatListOf(logOf(watched), epochs)({ limit: 200 }, undefined);
  await chatListOf(logOf(watched), epochs)({ limit: 200 }, undefined);
  assert.equal(reads.n, 1, 'its checkpoint was read once');
});

test('a journal over the size limit keeps its stand-in, is counted, and gets its title when it is opened', async (t) => {
  const data = tmp(t);
  const j = createSessionJournal({ dataDir: data });
  standIns(j, data, ['claude:small']);
  standIns(j, data, ['claude:big']);
  for (let i = 0; i < 3; i++)
    j.durable('claude:big', { seq: j.next('claude:big'), rev: j.head('claude:big').rev + 1, item: { type: 'x', text: 'y'.repeat(800) } });
  const listing = createSessionJournal({ dataDir: data, listing: { fillMax: 1500 } });
  const answer = await chatListOf(logOf(listing), epochs)({ limit: 200 }, undefined);
  assert.deepEqual(answer.titles, { pending: 0, deferred: 1 });
  assert.deepEqual(Object.fromEntries(answer.chats.map((c: any) => [c.chatId, c.title])), {
    'claude:small': 'Title claude:small',
    'claude:big': '',
  });
  listing.read('claude:big');
  const after = await chatListOf(logOf(listing), epochs)({ limit: 200 }, undefined);
  assert.deepEqual(after.titles, { pending: 0, deferred: 0 });
  assert.equal(after.chats.find((c: any) => c.chatId === 'claude:big')?.title, 'Title claude:big', 'opened: it has its title');
});

test('a chat deleted while titles are being found is dropped and nothing is written for it; a journal that cannot be read keeps its stand-in and is not tried again', async (t) => {
  const data = tmp(t);
  const j = createSessionJournal({ dataDir: data });
  standIns(j, data, ['claude:a', 'claude:b', 'claude:broken']);
  touch(path.join(dirOf(data, 'claude:a'), 'events'), 3000);
  touch(path.join(dirOf(data, 'claude:b'), 'events'), 2000);
  touch(path.join(dirOf(data, 'claude:broken'), 'events'), 1000);
  // the checkpoint's start still names the chat, but a later byte no longer matches its checksum
  const bad = path.join(dirOf(data, 'claude:broken'), 'checkpoint');
  const text = fs.readFileSync(bad, 'utf8');
  fs.writeFileSync(bad, `${text.slice(0, -3)}zz\n`);
  const reports: string[] = [];
  const listing = createSessionJournal({ dataDir: data, report: (m: string) => reports.push(m) });
  const remover = createSessionJournal({ dataDir: data });
  const log = logOf(listing, (id, real) => {
    if (id === 'claude:a') remover.remove('claude:b');
    return real();
  });
  const answer = await chatListOf(log, epochs)({ limit: 200 }, undefined);
  assert.deepEqual(
    answer.chats.map((c: any) => [c.chatId, c.title]),
    [
      ['claude:a', 'Title claude:a'],
      ['claude:broken', ''],
    ],
  );
  assert.deepEqual(answer.titles, { pending: 0, deferred: 1 });
  assert.equal(fs.existsSync(dirOf(data, 'claude:b')), false, 'no summary was made for a chat that is gone');
  assert.match(summaryOf(data, 'claude:broken'), /"provisional":true/, 'a failed read never leaves a blank title that looks real');
  assert.equal(reports.filter((m) => m.includes('Could not find the title')).length, 1);
  await chatListOf(log, epochs)({ limit: 200 }, undefined);
  assert.equal(reports.filter((m) => m.includes('Could not find the title')).length, 1, 'it is not tried again');
});

test('the journal of a chat the caller may not see is not read for a title, and two calls racing on a chat read it once', async (t) => {
  const data = tmp(t);
  const j = createSessionJournal({ dataDir: data });
  standIns(j, data, ['claude:open', 'claude:hidden']);
  const reads: string[] = [];
  const io = fsWith({
    readFileSync: (real: any, f: string, ...rest: unknown[]) => {
      if (String(f).endsWith('checkpoint') || String(f).endsWith('events')) reads.push(String(f));
      return real(f, ...rest);
    },
  });
  const listing = createSessionJournal({ dataDir: data, io });
  const list = chatListOf(logOf(listing), epochs, () => (id: string) => id !== 'claude:hidden');
  const answer = await list({ limit: 200 }, 'plain');
  assert.deepEqual(
    answer.chats.map((c: any) => c.chatId),
    ['claude:open'],
  );
  assert.deepEqual(answer.titles, { pending: 0, deferred: 0 }, 'nothing about the hidden chat is counted');
  assert.equal(
    reads.some((f) => f.includes(path.basename(dirOf(data, 'claude:hidden')))),
    false,
  );
  assert.equal(
    reads.some((f) => f.includes(path.basename(dirOf(data, 'claude:open')))),
    true,
  );
  // two calls at once on one chat: the second finds it already done
  standIns(j, data, ['claude:race']);
  reads.length = 0;
  // (the index is read from the journals once, when it is first asked: a chat that appeared on disk since needs a Host that starts again)
  const restarted = chatListOf(logOf(createSessionJournal({ dataDir: data, io })), epochs, () => (id: string) => id !== 'claude:hidden');
  const [one, two] = await Promise.all([restarted({ limit: 200 }, 'plain'), restarted({ limit: 200 }, 'plain')]);
  for (const r of [one, two]) assert.equal(r.chats.find((c: any) => c.chatId === 'claude:race')?.title, 'Title claude:race');
  assert.equal(reads.filter((f) => f.includes(path.basename(dirOf(data, 'claude:race'))) && f.endsWith('checkpoint')).length, 1);
  assert.doesNotMatch(summaryOf(data, 'claude:race'), /provisional/);
});

/** A line the way the journal writes one: its checksum, a space, the JSON. */
const line = (v: object) => {
  const text = JSON.stringify(v);
  return `${crypto.createHash('sha256').update(text).digest('hex')} ${text}\n`;
};
/** A chat folder with only the checkpoint given (no summary), as an older Host or a damaged disk leaves it. */
const plant = (data: string, chatId: string, checkpoint: object) => {
  fs.mkdirSync(dirOf(data, chatId), { recursive: true });
  fs.writeFileSync(path.join(dirOf(data, chatId), 'checkpoint'), line(checkpoint));
};
const checkpointOf = (chatId: string, over: object = {}) => ({
  version: 1,
  chatId,
  generation: 'g',
  n: 0,
  reserved: 5,
  frames: [],
  state: {},
  ...over,
});

test('a journal a load refuses is never given a real-looking summary: the title search checks the checkpoint exactly as a load does', async (t) => {
  const data = tmp(t);
  const corrupt: Record<string, object> = {
    'claude:array-state': checkpointOf('claude:array-state', { state: [] }),
    'claude:no-generation': checkpointOf('claude:no-generation', { generation: '' }),
    'claude:bad-frame': checkpointOf('claude:bad-frame', { frames: [{ seq: 1, rev: 7, item: {} }] }),
    'claude:frame-without-item': checkpointOf('claude:frame-without-item', { frames: [{ seq: 1, rev: 1 }] }),
  };
  for (const [id, body] of Object.entries(corrupt)) plant(data, id, body);
  plant(data, 'claude:fine', checkpointOf('claude:fine', { state: { title: { name: 'Fine', provisional: null }, harness: 'codex' } }));
  const reports: string[] = [];
  const listing = createSessionJournal({ dataDir: data, report: (m: string) => reports.push(m) });
  const answer = await chatListOf(logOf(listing), epochs)({ limit: 200 }, undefined);
  assert.deepEqual(answer.titles, { pending: 0, deferred: 4 });
  const fine = answer.chats.find((c: any) => c.chatId === 'claude:fine');
  assert.deepEqual([fine.title, fine.harness], ['Fine', 'codex'], 'a good one is filled, with the agent it moved to');
  for (const id of Object.keys(corrupt)) {
    assert.match(summaryOf(data, id), /"provisional":true/, `${id}: still a stand-in`);
    assert.throws(
      () => createSessionJournal({ dataDir: data }).read(id),
      /corrupt|invalid durable history/,
      `${id}: a load refuses it too`,
    );
  }
  assert.equal(reports.length, 4);
  // events whose record number is not a number, and events already in the checkpoint (an old record), are read like a load reads them
  plant(data, 'claude:bad-record', checkpointOf('claude:bad-record'));
  fs.writeFileSync(path.join(dirOf(data, 'claude:bad-record'), 'events'), line({ n: 'one', kind: 'state', patch: {} }));
  plant(data, 'claude:old-record', checkpointOf('claude:old-record', { n: 3 }));
  fs.writeFileSync(
    path.join(dirOf(data, 'claude:old-record'), 'events'),
    line({ n: 2, kind: 'state', patch: { title: { name: 'Stale', provisional: null } } }),
  );
  const again = createSessionJournal({ dataDir: data, report: () => undefined });
  assert.equal(again.fillTitle('claude:bad-record').status, 'deferred');
  assert.throws(() => createSessionJournal({ dataDir: data }).read('claude:bad-record'), /invalid record number/);
  const old = again.fillTitle('claude:old-record');
  assert.deepEqual([old.status, (old as any).title], ['filled', ''], 'a record the checkpoint already holds changes nothing');
  // a chat that has events but no checkpoint is not filled either: a load refuses it
  fs.mkdirSync(dirOf(data, 'claude:no-checkpoint'), { recursive: true });
  fs.writeFileSync(path.join(dirOf(data, 'claude:no-checkpoint'), 'events'), 'x');
  fs.rmSync(path.join(dirOf(data, 'claude:fine'), 'summary'));
  assert.equal((await createSessionJournal({ dataDir: data }).fillTitle('claude:no-checkpoint')).status, 'deferred');
});

test('a write that fails is not a journal that cannot be read: the filling stops for that call, says so once, and the next call finds the titles', async (t) => {
  const data = tmp(t);
  standIns(createSessionJournal({ dataDir: data }), data, ['claude:a', 'claude:b', 'claude:c']);
  let full = true;
  const reports: string[] = [];
  const io = fsWith({
    openSync: (real: any, file: string, ...rest: unknown[]) => {
      if (full && String(file).endsWith('summary.next')) throw new Error('disk full');
      return real(file, ...rest);
    },
  });
  const listing = createSessionJournal({ dataDir: data, io, report: (m: string) => reports.push(m), listing: { writeBack: 0 } });
  const list = chatListOf(logOf(listing), epochs);
  const first = await list({ limit: 200 }, undefined);
  assert.deepEqual(first.titles, { pending: 3, deferred: 0 }, 'all three wait for a later call, none is "unreadable"');
  assert.equal(reports.filter((m) => m.includes('Could not keep the title')).length, 1, 'tried and said once');
  full = false;
  const second = await list({ limit: 200 }, undefined);
  assert.deepEqual(second.titles, { pending: 0, deferred: 0 });
  assert.deepEqual(second.chats.map((c: any) => c.title).sort(), ['Title claude:a', 'Title claude:b', 'Title claude:c']);
});

test('a chat with no summary file at all is filled and dated by its folder; one that moved to another agent keeps it; one another call made real is returned as it is', async (t) => {
  const data = tmp(t);
  const j = createSessionJournal({ dataDir: data });
  standIns(j, data, ['claude:moved']);
  j.state('claude:moved', { harness: 'codex' });
  fs.rmSync(path.join(dirOf(data, 'claude:moved'), 'summary'), { force: true });
  // writeBack 0: the list makes no stand-in file, so the fill has no earlier summary to take the start time from
  const listing = createSessionJournal({ dataDir: data, listing: { writeBack: 0 } });
  const list = chatListOf(logOf(listing), epochs);
  const [one, two] = await Promise.all([list({ limit: 200 }, undefined), list({ limit: 200 }, undefined)]);
  for (const r of [one, two]) {
    assert.deepEqual([r.chats[0].title, r.chats[0].harness], ['Title claude:moved', 'codex']);
  }
  assert.match(summaryOf(data, 'claude:moved'), /"harness":"codex"/);
  assert.ok(JSON.parse(summaryOf(data, 'claude:moved').slice(65)).createdAt > 0);
});

test('a summary that belongs to another chat is not believed when this chat is loaded; its own is made from the chat', async (t) => {
  const data = tmp(t);
  const j = createSessionJournal({ dataDir: data });
  standIns(j, data, ['claude:a', 'claude:b']);
  j.state('claude:a', { title: { name: 'Title claude:a', provisional: null } });
  const b = path.join(dirOf(data, 'claude:b'), 'summary');
  const a = path.join(dirOf(data, 'claude:a'), 'summary');
  fs.writeFileSync(b, line({ v: 1, chatId: 'claude:a', createdAt: 5, title: 'Not b' }));
  fs.rmSync(a, { force: true });
  createSessionJournal({ dataDir: data }).read('claude:b');
  assert.equal(JSON.parse(fs.readFileSync(b, 'utf8').slice(65)).chatId, 'claude:b');
  assert.equal(JSON.parse(fs.readFileSync(b, 'utf8').slice(65)).title, 'Title claude:b');
});

test('the Host may list a chat whose folder shows nothing readable: it is dated now', async (t) => {
  const data = tmp(t);
  write(createSessionJournal({ dataDir: data }), 'claude:a');
  const dir = dirOf(data, 'claude:a');
  fs.rmSync(path.join(dir, 'summary'));
  const before = Date.now();
  const noFiles = fsWith({
    statSync: (real: any, f: string, ...rest: unknown[]) => {
      if (String(f).startsWith(dir) && !String(f).endsWith('checkpoint')) throw new Error('gone');
      return real(f, ...rest);
    },
    readdirSync: (real: any, f: string, ...rest: unknown[]) => {
      if (f === dir) return ['gone-since'];
      return real(f, ...rest);
    },
  });
  const row = (await createSessionJournal({ dataDir: data, io: noFiles, report: () => undefined }).chats())[0];
  assert.ok(
    row.createdAt >= before && row.createdAt <= Date.now(),
    'a file that vanished between the listing and its date does not stop the list',
  );
});

/** A chat whose journal holds about `bytes` bytes (one frame of that much text), with a title and no summary. */
const bigChat = (j: any, data: string, id: string, bytes: number) => {
  j.durable(id, { seq: j.next(id), rev: j.head(id).rev + 1, item: { type: 'x', text: 'y'.repeat(bytes) } });
  j.state(id, { title: { name: `Title ${id}`, provisional: null } });
  fs.rmSync(path.join(dirOf(data, id), 'summary'));
};

test('a long chat gets its title too: up to 8 MiB of journal is searched, a bigger one waits until it is opened', async (t) => {
  const data = tmp(t);
  const j = createSessionJournal({ dataDir: data });
  bigChat(j, data, 'claude:long', 2.6 * 1024 * 1024);
  bigChat(j, data, 'claude:huge', 8.4 * 1024 * 1024);
  const answer = await chatListOf(logOf(createSessionJournal({ dataDir: data })), epochs)({ limit: 200 }, undefined);
  assert.deepEqual(answer.titles, { pending: 0, deferred: 1 });
  assert.deepEqual(Object.fromEntries(answer.chats.map((c: any) => [c.chatId, c.title])), {
    'claude:long': 'Title claude:long',
    'claude:huge': '',
  });
  createSessionJournal({ dataDir: data }).read('claude:huge');
  const after = await chatListOf(logOf(createSessionJournal({ dataDir: data })), epochs)({ limit: 200 }, undefined);
  assert.deepEqual(after.titles, { pending: 0, deferred: 0 });
  assert.equal(after.chats.find((c: any) => c.chatId === 'claude:huge')?.title, 'Title claude:huge', 'opened: it has its title');
});

test('one call reads a bounded number of journal bytes: what does not fit waits for a later call, newest first, and is pending, not deferred', async (t) => {
  const data = tmp(t);
  const j = createSessionJournal({ dataDir: data });
  const ids = ['claude:a', 'claude:b', 'claude:c', 'claude:d'];
  ids.forEach((id) => bigChat(j, data, id, 3000));
  ids.forEach((id, i) => touch(path.join(dirOf(data, id), 'events'), (ids.length - i) * 1000));
  // room for two of these journals per call
  const size = (id: string) => ['checkpoint', 'events'].reduce((n, f) => n + fs.statSync(path.join(dirOf(data, id), f)).size, 0);
  const list = chatListOf(logOf(createSessionJournal({ dataDir: data })), epochs, undefined, {
    bytes: size('claude:a') + size('claude:b') + 10,
  });
  const first = await list({ limit: 200 }, undefined);
  assert.deepEqual(first.titles, { pending: 2, deferred: 0 });
  assert.deepEqual(
    first.chats.map((c: any) => c.title),
    ['Title claude:a', 'Title claude:b', '', ''],
    'the two newest',
  );
  const second = await list({ limit: 200 }, undefined);
  assert.deepEqual(second.titles, { pending: 0, deferred: 0 });
  assert.deepEqual(
    second.chats.map((c: any) => c.title),
    ['Title claude:a', 'Title claude:b', 'Title claude:c', 'Title claude:d'],
  );
  // the number of titles a call finds is bounded too
  standIns(createSessionJournal({ dataDir: data }), data, ['claude:x', 'claude:y', 'claude:z']);
  const few = await chatListOf(logOf(createSessionJournal({ dataDir: data })), epochs, undefined, { perCall: 2 })(
    { limit: 200 },
    undefined,
  );
  assert.deepEqual(few.titles, { pending: 1, deferred: 0 });
});

test('with the real limits one call reads at most 16 MiB of journal files in all: two chats of about 7 MiB, and the third waits for the next call', async (t) => {
  const data = tmp(t);
  const j = createSessionJournal({ dataDir: data });
  const ids = ['claude:a', 'claude:b', 'claude:c'];
  ids.forEach((id) => bigChat(j, data, id, 7 * 1024 * 1024));
  ids.forEach((id, i) => touch(path.join(dirOf(data, id), 'events'), (ids.length - i) * 1000));
  const bytes = (id: string) => ['checkpoint', 'events'].reduce((n, f) => n + fs.statSync(path.join(dirOf(data, id), f)).size, 0);
  assert.ok(bytes('claude:a') * 2 <= 16 * 1024 * 1024 && bytes('claude:a') * 3 > 16 * 1024 * 1024, 'two fit the budget, three do not');
  const read: string[] = [];
  const io = fsWith({
    readFileSync: (real: any, f: string, ...rest: unknown[]) => (
      String(f).endsWith('checkpoint') && read.push(String(f)), real(f, ...rest)
    ),
  });
  const list = chatListOf(logOf(createSessionJournal({ dataDir: data, io })), epochs);
  const first = await list({ limit: 200 }, undefined);
  assert.deepEqual(first.titles, { pending: 1, deferred: 0 });
  assert.deepEqual(
    first.chats.map((c: any) => c.title),
    ['Title claude:a', 'Title claude:b', ''],
  );
  assert.equal(read.length, 2, 'the third journal was not read in this call');
  const second = await list({ limit: 200 }, undefined);
  assert.deepEqual(second.titles, { pending: 0, deferred: 0 });
  assert.equal(second.chats[2].title, 'Title claude:c');
});
