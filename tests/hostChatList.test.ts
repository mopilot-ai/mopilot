// `host.chats` (#4884): the chats a Host holds, from a small summary kept beside each journal, newest activity first and bounded; a deleted chat is not listed, a chat from before summaries gets one when it is next loaded, and a summary that cannot be written never fails the chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSessionJournal } from '../host/src/sessionJournal.mjs';
import { helloParams, parseParams, requireFeatures } from '../shared/host/schema.mjs';
import { harnessOfHostChat } from '../shared/host/chatIds.mjs';
import { journalWorld } from './support/host/journalFaultKit';
import chatsMethods from '../host/src/methods/chats.mjs';
import { chatListOf } from '../host/src/chatList.mjs';
import { createChatLog } from '../host/src/chatLog.mjs';
import { BASE, dirOf, fsWith, tmp, touch, write } from './support/host/chatListKit';

test('a chat is listed with its title and agent, newest activity first, bounded, and a deleted one is not', async (t) => {
  const data = tmp(t);
  const j = createSessionJournal({ dataDir: data });
  assert.deepEqual(await j.chats(), [], 'no sessions folder yet');
  for (const id of ['claude:a', 'acp:kimi:b', 'codex-c']) write(j, id);
  j.state('claude:a', { title: { name: 'Fix the build', provisional: null } });
  j.state('acp:kimi:b', { title: { name: '', provisional: 'first words' } });
  j.state('codex-c', { harness: 'claude' });
  // activity order is the journal's last write
  touch(path.join(dirOf(data, 'claude:a'), 'events'), 3000);
  touch(path.join(dirOf(data, 'acp:kimi:b'), 'events'), 2000);
  touch(path.join(dirOf(data, 'codex-c'), 'events'), 3000);
  const rows = await j.chats();
  assert.deepEqual(
    rows.map((r: any) => [r.chatId, r.title, r.harness ?? null, r.updatedAt - BASE]),
    [
      ['claude:a', 'Fix the build', null, 3000],
      ['codex-c', '', 'claude', 3000],
      ['acp:kimi:b', 'first words', null, 2000],
    ],
    'newest first, ties by id; a title falls back to the cut-short one; a switched chat names its agent now',
  );
  assert.ok(rows.every((r: any) => r.createdAt > 0));
  j.remove('claude:a');
  assert.deepEqual(
    (await j.chats()).map((r: any) => r.chatId),
    ['codex-c', 'acp:kimi:b'],
  );
  // an unchanged title is not written again
  j.state('acp:kimi:b', { title: { name: '', provisional: 'first words' } });
  j.state('acp:kimi:b', { goal: null });
  assert.equal((await j.chats()).find((r: any) => r.chatId === 'acp:kimi:b')?.title, 'first words');
});

test('a chat written before summaries existed is listed from its checkpoint with no title, and gets its summary when it is loaded; a bad summary is not listed', async (t) => {
  const data = tmp(t);
  const first = createSessionJournal({ dataDir: data });
  write(first, 'claude:old');
  first.state('claude:old', { title: { name: 'Old title', provisional: null } });
  write(first, 'claude:other');
  const summary = (id: string) => path.join(dirOf(data, id), 'summary');
  fs.rmSync(summary('claude:old'));
  const next = createSessionJournal({ dataDir: data });
  const before = (await next.chats()).find((r: any) => r.chatId === 'claude:old');
  assert.deepEqual([before?.title, before?.harness ?? null], ['', null], 'listed from the first bytes of its checkpoint, no title yet');
  assert.ok(before!.createdAt > 0);
  next.read('claude:old');
  assert.equal(
    (await next.chats()).find((r: any) => r.chatId === 'claude:old')?.title,
    'Old title',
    'its summary is made when it is loaded',
  );
  assert.ok(fs.existsSync(summary('claude:old')));
  // torn, foreign (another chat's summary in this folder), wrong shape and unreadable ones are left out
  const good = fs.readFileSync(summary('claude:other'), 'utf8');
  const ids = async () => (await next.chats()).map((r: any) => r.chatId).sort();
  fs.writeFileSync(summary('claude:other'), good.slice(0, 10));
  assert.deepEqual(await ids(), ['claude:old', 'claude:other'], 'a torn summary falls back to the checkpoint');
  assert.ok(fs.existsSync(summary('claude:other')), 'and its summary was made from the checkpoint');
  fs.rmSync(path.join(dirOf(data, 'claude:other'), 'checkpoint'));
  fs.rmSync(summary('claude:other'));
  assert.deepEqual(await ids(), ['claude:old'], 'a chat with nothing readable is not listed');
  fs.writeFileSync(summary('claude:other'), fs.readFileSync(summary('claude:old'), 'utf8'));
  assert.deepEqual(await ids(), ['claude:old'], "another chat's summary under this folder");
  const line = (v: object) => {
    const text = JSON.stringify(v);
    return `${crypto.createHash('sha256').update(text).digest('hex')} ${text}\n`;
  };
  for (const bad of [
    { v: 2 },
    { v: 1, chatId: 7 },
    { v: 1, chatId: 'claude:other', createdAt: -1, title: '' },
    { v: 1, chatId: 'claude:other', createdAt: 1, title: 4 },
    { v: 1, chatId: 'claude:other', createdAt: 1, title: '', harness: 9 },
  ]) {
    fs.writeFileSync(summary('claude:other'), line(bad));
    assert.deepEqual(await ids(), ['claude:old']);
  }
  // a folder that is not a chat's, and a checkpoint whose first bytes do not name the chat the folder is for
  fs.mkdirSync(path.join(data, 'sessions', 'not-a-chat'), { recursive: true });
  const stray = path.join(data, 'sessions', crypto.createHash('sha256').update('claude:stray').digest('hex'));
  fs.mkdirSync(stray);
  for (const body of ['garbage', `${'0'.repeat(64)} {"version":1,"chatId":"claude:other"}`, `${'0'.repeat(64)} {"version":1,"chatId":3}`])
    for (const f of ['checkpoint']) {
      fs.writeFileSync(path.join(stray, f), body);
      assert.deepEqual(await ids(), ['claude:old']);
    }
  fs.rmSync(path.join(dirOf(data, 'claude:old'), 'events'));
  assert.deepEqual(await ids(), ['claude:old'], 'a chat with only its checkpoint is dated by that');
  fs.rmSync(path.join(dirOf(data, 'claude:old'), 'checkpoint'));
  fs.rmSync(summary('claude:old'));
  assert.deepEqual(await ids(), [], 'and one with nothing is not listed');
});

test('a chat whose checkpoint start cannot be read still gets its summary when it is loaded, dated now', async (t) => {
  const data = tmp(t);
  write(createSessionJournal({ dataDir: data }), 'claude:a');
  fs.rmSync(path.join(dirOf(data, 'claude:a'), 'summary'));
  const io: any = new Proxy(fs, {
    get: (target, key: string) =>
      key === 'readSync'
        ? () => {
            throw new Error('io');
          }
        : (target as any)[key],
  });
  const j = createSessionJournal({ dataDir: data, io });
  const before = Date.now();
  j.read('claude:a');
  const row = (await createSessionJournal({ dataDir: data }).chats())[0];
  assert.ok(row.createdAt >= before - 1000 && row.createdAt <= Date.now());
});

test('a summary that cannot be written is reported and never fails the chat', async (t) => {
  const data = tmp(t);
  const reports: string[] = [];
  const io: any = new Proxy(fs, {
    get: (target, key: string) =>
      key === 'openSync'
        ? (file: string, ...rest: unknown[]) => {
            if (String(file).endsWith('summary.next')) throw new Error('disk full');
            return (target as any).openSync(file, ...rest);
          }
        : (target as any)[key],
  });
  const j = createSessionJournal({ dataDir: data, io, report: (m: string) => reports.push(m) });
  write(j, 'claude:a');
  j.state('claude:a', { title: { name: 'T', provisional: null } });
  assert.equal(j.head('claude:a').rev, 1, 'the chat still took its frame and its title');
  assert.equal(j.read('claude:a').state.title.name, 'T');
  assert.ok(reports.some((m) => m.includes('Could not keep the chat summary for claude:a: disk full')));
  assert.deepEqual(
    (await j.chats()).map((r: any) => [r.chatId, r.title]),
    [['claude:a', '']],
    'it is listed from its checkpoint, without the title the summary would have carried',
  );
  const unreadable: any = new Proxy(fs, {
    get: (target, key: string) =>
      key === 'readdirSync'
        ? () => {
            throw new Error('denied');
          }
        : (target as any)[key],
  });
  assert.deepEqual(await createSessionJournal({ dataDir: data, io: unreadable }).chats(), []);
});

test('the Host answers host.chats with each row’s agent and epoch, and only to a client that agreed to chatList', async (t) => {
  const data = tmp(t);
  const s = journalWorld(data);
  const ids = ['claude:a', 'acp:kimi:b', 'plain-codex'];
  const opened: Awaited<ReturnType<typeof s.open>>[] = [];
  for (const id of ids) opened.push(await s.open(id));
  s.host.emit('event', { kind: 'threadName', key: 'claude:a', name: 'Fix the build' });
  s.host.emit('event', { kind: 'turnStart', key: 'plain-codex', turnId: 'native' });
  s.host.emit('event', { kind: 'turnStart', key: 'acp:kimi:b', turnId: 'native2' });
  // a chat nothing was written for is not on disk, so it is not listed
  await s.open('claude:never');
  const { conn } = opened[0];
  const answer = await conn.call('host.chats', {});
  assert.deepEqual(
    answer.chats.map((c: any) => [c.chatId, c.harness, c.epoch]).sort(),
    [
      ['acp:kimi:b', 'acp:kimi', 1],
      ['claude:a', 'claude', 1],
      ['plain-codex', 'codex', 1],
    ].sort(),
  );
  assert.equal(answer.chats.find((c: any) => c.chatId === 'claude:a').title, 'Fix the build');
  assert.equal((await conn.call('host.chats', { limit: 1 })).chats.length, 1);
  for (const limit of [0, 201, 1.5, '3']) assert.throws(() => parseParams('host.chats', { limit }), /holds 1 to 200/);
  assert.deepEqual(parseParams('host.chats', {}), { limit: 200 });
  // a client that did not agree to the feature is refused, never served in a degraded way
  const older = s.protocol.connection(() => {});
  await older.call('host.hello', { ...helloParams(), features: helloParams().features.filter((f: string) => f !== 'chatList') });
  await assert.rejects(older.call('host.chats', {}), /chatList|feature|update/i);
  assert.throws(() => requireFeatures('host.chats', { minor: 1, features: [] } as any, {}), Error);
  assert.ok((await conn.call('host.hello', helloParams())).agreed.features.includes('chatList'));
});

test('the wire harness of a chat comes from the id the Host knows it by', async () => {
  assert.deepEqual(['claude:1', 'acp:kimi:1', 'acp:opencode:x:y', '0b2f'].map(harnessOfHostChat), [
    'claude',
    'acp:kimi',
    'acp:opencode',
    'codex',
  ]);
});

test('the handler refuses when its Host has no list to give, and passes the limit and the caller on when it has', async () => {
  assert.throws(() => (chatsMethods({}) as any).handlers['host.chats']({ limit: 5 }), /keeps no chats/);
  const log = { chats: async () => [{ chatId: 'claude:a' }, { chatId: 'claude:b' }], fillTitle: () => ({ status: 'deferred' }) };
  const made: any = chatsMethods({
    dataDir: '/data',
    log,
    epochs: { current: () => 4 },
    chatVisible: (who: any) => (id: string) => who === 'x' && id === 'claude:b',
  } as any);
  assert.deepEqual(await made.handlers['host.chats']({ limit: 5 }, 'desktop', 'x'), {
    chats: [{ chatId: 'claude:b', harness: 'claude', epoch: 4 }],
    titles: { pending: 0, deferred: 0 },
  });
  assert.equal(
    (await made.handlers['host.chats']({ limit: 1 }, 'desktop', 'y')).chats.length,
    0,
    'a caller that may see none is told none',
  );
});

test('what a caller may not see is left out before the list is cut, so a short list says nothing about what was left out', async () => {
  const rows = ['claude:hidden-1', 'claude:a', 'claude:hidden-2', 'claude:b', 'claude:c'].map((chatId) => ({ chatId }));
  const log = { chats: async () => rows, fillTitle: () => ({ status: 'deferred' }) };
  const epochs = { current: () => 2 };
  const asked: unknown[] = [];
  const list = chatListOf(log, epochs, (who) => (asked.push(who), who === 'plain' ? (id: string) => !id.includes('hidden') : undefined));
  assert.deepEqual(
    (await list({ limit: 2 }, 'plain')).chats.map((c: any) => c.chatId),
    ['claude:a', 'claude:b'],
    'two visible chats, not the first two minus the hidden one',
  );
  assert.deepEqual(
    (await list({ limit: 3 }, 'granted')).chats.map((c: any) => c.chatId),
    ['claude:hidden-1', 'claude:a', 'claude:hidden-2'],
    'a caller with the grant sees them',
  );
  assert.deepEqual((await chatListOf(log, epochs)({ limit: 9 }, undefined)).chats.length, 5, 'with no veil everything is visible');
  assert.deepEqual(asked, ['plain', 'granted']);
});

test('a chat without a summary gets one from its checkpoint when it is listed, at most a bounded number a call, never for a deleted or loaded chat; its files are as private as the checkpoint', async (t) => {
  const data = tmp(t);
  const j = createSessionJournal({ dataDir: data });
  const ids = Array.from({ length: 25 }, (_, i) => `claude:legacy-${i}`);
  for (const id of ids) {
    write(j, id);
    fs.rmSync(path.join(dirOf(data, id), 'summary'));
  }
  const fresh = createSessionJournal({ dataDir: data, listing: { writeBack: 10 } });
  const made = () => ids.filter((id) => fs.existsSync(path.join(dirOf(data, id), 'summary'))).length;
  assert.equal((await fresh.chats()).length, 25, 'every chat is listed on the first call');
  assert.equal(made(), 10, 'one call writes at most its bound of summaries (100 by default)');
  assert.equal((await fresh.chats()).length, 25);
  await fresh.chats();
  assert.equal(made(), 25, 'the next call writes the rest, and the first bytes of each checkpoint are read once');
  const file = path.join(dirOf(data, ids[0]), 'summary');
  assert.equal(
    fs.statSync(file).mode & 0o777,
    fs.statSync(path.join(dirOf(data, ids[0]), 'checkpoint')).mode & 0o777,
    'the summary has the checkpoint’s permissions',
  );
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dirOf(data, ids[0])).mode & 0o777, 0o700);
  // a deleted chat (its tombstone is there, its folder not yet gone after a crash) and a chat the journal holds are not written
  const held = createSessionJournal({ dataDir: data });
  for (const id of ['claude:legacy-0', 'claude:legacy-1']) fs.rmSync(path.join(dirOf(data, id), 'summary'));
  fs.writeFileSync(`${dirOf(data, 'claude:legacy-0')}.deleted`, '');
  held.read('claude:legacy-1');
  fs.rmSync(path.join(dirOf(data, 'claude:legacy-1'), 'summary'));
  const rows = await held.chats();
  assert.ok(!rows.some((r: any) => r.chatId === 'claude:legacy-0'), 'a tombstoned chat is not listed');
  assert.ok(rows.some((r: any) => r.chatId === 'claude:legacy-1'));
  assert.equal(fs.existsSync(path.join(dirOf(data, 'claude:legacy-0'), 'summary')), false, 'and no summary is made for it');
  assert.equal(
    fs.existsSync(path.join(dirOf(data, 'claude:legacy-1'), 'summary')),
    false,
    'nor for a chat the journal holds: it keeps its own',
  );
});

test('after a crash between the journal write and the summary write the checkpoint wins: the list may be one title behind, and the next load puts it right', async (t) => {
  const data = tmp(t);
  const first = createSessionJournal({ dataDir: data });
  write(first, 'claude:a');
  first.state('claude:a', { title: { name: 'Old title', provisional: null } });
  const crash: any = new Proxy(fs, {
    get: (target, key: string) =>
      key === 'openSync'
        ? (file: string, ...rest: unknown[]) => {
            if (String(file).endsWith('summary.next')) throw new Error('crash');
            return (target as any).openSync(file, ...rest);
          }
        : (target as any)[key],
  });
  const dying = createSessionJournal({ dataDir: data, io: crash, report: () => undefined });
  dying.state('claude:a', { title: { name: 'New title', provisional: null } });
  const after = createSessionJournal({ dataDir: data });
  assert.equal((await after.chats())[0].title, 'Old title', 'the summary is a valid but stale copy');
  assert.equal(after.read('claude:a').state.title.name, 'New title', 'the journal has the truth');
  assert.equal((await after.chats())[0].title, 'New title', 'loading the chat rebuilt the summary from it');
  // a summary with a bad checksum is rebuilt the same way
  const file = path.join(dirOf(data, 'claude:a'), 'summary');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('New title', 'Wrong title'));
  const again = createSessionJournal({ dataDir: data });
  assert.equal((await again.chats())[0].title, '', 'a summary that does not check is not believed; the chat is listed from its checkpoint');
  again.read('claude:a');
  assert.equal((await createSessionJournal({ dataDir: data }).chats())[0].title, 'New title');
});

test('the list is whole while chats settle, and a Host with no data directory holds none', async (t) => {
  const data = tmp(t);
  const j = createSessionJournal({ dataDir: data });
  for (const id of ['claude:a', 'claude:b', 'claude:c']) write(j, id);
  const before = (await j.chats()).map((r: any) => r.chatId);
  write(j, 'claude:a');
  j.state('claude:b', { title: { name: 'Settled', provisional: null } });
  const after = await j.chats();
  assert.deepEqual([...after.map((r: any) => r.chatId)].sort(), [...before].sort(), 'no chat twice, none missing');
  assert.equal(after.find((r: any) => r.chatId === 'claude:b')?.title, 'Settled');
  assert.deepEqual(await createChatLog({ epoch: () => 1 }).chats(), []);
});

test('a chat is dated by its folder, not by its checkpoint, which every rotation replaces; with no birth time the oldest write in the folder says', async (t) => {
  const data = tmp(t);
  write(createSessionJournal({ dataDir: data }), 'claude:a');
  const dir = dirOf(data, 'claude:a');
  const stat = (real: any, file: string, ...rest: unknown[]) => real(file, ...rest);
  const listed = async (over: Record<string, any>) => {
    fs.rmSync(path.join(dir, 'summary'), { force: true });
    return (await createSessionJournal({ dataDir: data, io: fsWith({ statSync: over.statSync ?? stat }) }).chats())[0].createdAt;
  };
  const answering =
    (folder: number, files = 5_000_000) =>
    (real: any, file: string, ...rest: unknown[]) => {
      const st = real(file, ...rest);
      return { ...st, birthtimeMs: file === dir ? folder : files, mtimeMs: file === dir ? st.mtimeMs : 7_000_000 };
    };
  assert.equal(
    await listed({ statSync: answering(1_000_000) }),
    1_000_000,
    'the folder was made at the first save; the rotated checkpoint is newer',
  );
  // a file system with no birth time says 0: the oldest write time of the folder's files is then the best date
  const noBirth = (real: any, file: string, ...rest: unknown[]) => {
    const st = real(file, ...rest);
    return {
      ...st,
      birthtimeMs: 0,
      ...(file.startsWith(dir) && file !== dir ? { mtimeMs: file.endsWith('events') ? 9_000_000 : 8_000_000 } : {}),
    };
  };
  assert.equal(await listed({ statSync: noBirth }), 8_000_000);
  // and when nothing can be read at all, now
  const before = Date.now();
  const nothing = fsWith({
    statSync: (real: any, file: string, ...rest: unknown[]) => {
      if (file.startsWith(dir) && !file.endsWith('checkpoint')) throw new Error('gone');
      return real(file, ...rest);
    },
    readdirSync: (real: any, file: string, ...rest: unknown[]) => {
      if (file === dir) throw new Error('gone');
      return real(file, ...rest);
    },
  });
  fs.rmSync(path.join(dir, 'summary'), { force: true });
  const row = (await createSessionJournal({ dataDir: data, io: nothing, report: () => undefined }).chats())[0];
  assert.ok(row.createdAt >= before && row.createdAt <= Date.now());
  // a chat that really rotated keeps the date of its folder
  const j = createSessionJournal({ dataDir: data, rotateBytes: 100 });
  const folderBorn = Math.round(fs.statSync(dir).birthtimeMs);
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (let i = 0; i < 3; i++) write(j, 'claude:a');
  fs.rmSync(path.join(dir, 'summary'), { force: true });
  const created = (await createSessionJournal({ dataDir: data }).chats())[0].createdAt;
  assert.equal(created, folderBorn > 0 ? folderBorn : created, 'the same day as the folder after rotations');
});

test('a title is written to disk; the summaries a list fills in are not synced, and a list stops writing after the first failure and says so once', async (t) => {
  const data = tmp(t);
  let syncs = 0;
  const counting = fsWith({ fsyncSync: (real: any, ...a: unknown[]) => (syncs++, real(...a)) });
  const j = createSessionJournal({ dataDir: data, io: counting });
  write(j, 'claude:a');
  const base = syncs;
  j.state('claude:a', { goal: null });
  const withoutTitle = syncs - base;
  const mid = syncs;
  j.state('claude:a', { title: { name: 'Kept', provisional: null } });
  assert.ok(syncs - mid > withoutTitle, 'a title change syncs its summary as well as the journal row');
  // legacy chats: the list writes their summaries without a sync, and stops at the first write that fails
  for (const id of ['claude:l1', 'claude:l2', 'claude:l3']) {
    write(j, id);
    fs.rmSync(path.join(dirOf(data, id), 'summary'));
  }
  const listing = createSessionJournal({ dataDir: data, io: counting });
  const before = syncs;
  await listing.chats();
  assert.equal(syncs, before, 'filling summaries in is not synced');
  for (const id of ['claude:l1', 'claude:l2', 'claude:l3']) fs.rmSync(path.join(dirOf(data, id), 'summary'));
  const reports: string[] = [];
  let opens = 0;
  const failing = fsWith({
    openSync: (real: any, file: string, ...rest: unknown[]) => {
      if (String(file).endsWith('summary.next')) {
        opens++;
        throw new Error('budget full');
      }
      return real(file, ...rest);
    },
  });
  const full = createSessionJournal({ dataDir: data, io: failing, report: (m: string) => reports.push(m) });
  assert.equal((await full.chats()).length, 4, 'every chat is still listed');
  assert.equal(opens, 1, 'after the first failed write the list does not try again');
  assert.equal(reports.length, 1);
});

test('a list lets the event loop go between chunks of folders', async (t) => {
  const data = tmp(t);
  const j = createSessionJournal({ dataDir: data });
  for (let i = 0; i < 7; i++) write(j, `claude:c${i}`);
  /** Whether something queued before the list ran while the list was still reading. */
  const ranDuring = async (chunk: number) => {
    let finished = false;
    let during = false;
    setImmediate(() => void (during = !finished));
    const rows = await createSessionJournal({ dataDir: data, listing: { chunk } }).chats();
    finished = true;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rows.length, 7);
    return during;
  };
  assert.equal(await ranDuring(2), true, 'the loop goes between chunks');
  assert.equal(await ranDuring(100), false, 'and not inside one: a list that fits a chunk is read in one go');
});

test('a torn summary of a chat that has a title is never made permanent as blank: the list stands one in that the next load replaces', async (t) => {
  const data = tmp(t);
  const first = createSessionJournal({ dataDir: data });
  write(first, 'claude:a');
  first.state('claude:a', { title: { name: 'Real title', provisional: null } });
  const file = path.join(dirOf(data, 'claude:a'), 'summary');
  const good = fs.readFileSync(file, 'utf8');
  for (const torn of ['', good.slice(0, good.length / 2), '\0'.repeat(good.length)]) {
    // what a power loss leaves of a summary that was renamed but not synced
    fs.writeFileSync(file, torn);
    const listing = createSessionJournal({ dataDir: data });
    assert.equal((await listing.chats())[0].title, '', 'the list only has the checkpoint’s first bytes');
    assert.match(fs.readFileSync(file, 'utf8'), /"provisional":true/, 'what it wrote is marked as a stand-in');
    assert.equal((await listing.chats())[0].title, '');
    listing.read('claude:a');
    assert.equal((await listing.chats())[0].title, 'Real title', 'the next load puts the title back');
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /provisional/);
  }
  // a marker that is not `true` is not a summary
  const line = (v: object) => {
    const text = JSON.stringify(v);
    return `${crypto.createHash('sha256').update(text).digest('hex')} ${text}\n`;
  };
  fs.writeFileSync(file, line({ v: 1, chatId: 'claude:a', createdAt: 5, title: 'Fake', provisional: false }));
  assert.equal((await createSessionJournal({ dataDir: data }).chats())[0].title, '');
});

test('the chat log answers the title search for a chat it does not hold, with or without a data directory', async (t) => {
  const none = createChatLog({ epoch: () => 1 });
  assert.deepEqual(none.fillTitle('claude:a'), { status: 'deferred' }, 'an embedder with no data directory holds no journals');
  const held = createChatLog({ dataDir: tmp(t), epoch: () => 1 });
  assert.deepEqual(await held.chats(), []);
  assert.deepEqual(held.fillTitle('claude:never-written'), { status: 'deferred' }, 'a chat with no journal has no title to find');
});
