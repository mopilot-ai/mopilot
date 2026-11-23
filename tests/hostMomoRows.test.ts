// The rows MoMo's chat holds beyond the harness's words: one durable row per id on a real sealed store, a cursor that never goes back (restart, a move to a machine whose clock is behind), open cards never evicted, the lease checked inside the write and on every read, row size caps and hashed ids, pages, the task core's card and notice as the rows the clients draw (against the fixture both UIs import), and who may read them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createMomoRows, resultRow, watchRow, rowsShape, ROWS_KEEP, PENDING_KEEP, PAGE, CAPS } from '../host/src/momoRows.mjs';
// @ts-ignore
import methods from '../host/src/methods/momoRows.mjs';
// @ts-ignore
import wire from '../shared/host/methods/momoRows.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
import { FIXTURE_ROWS, FIXTURE_RESULT, FIXTURE_WATCH, FIXTURE_MACHINE } from '../shared/momoRowsFixture.ts';

const require = createRequire(import.meta.url);
const { SealedJson } = require('../electron/gateway/sealedFile.cjs');

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: any) => String(e.code),
  );
/** A real sealed file of rows in a folder, as the home keeps it (`home.data.sealed`). */
const real = (t: any, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-rows-'))) => {
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const open = () =>
    new SealedJson({ file: path.join(dir, 'chat-rows.json'), safeStorage: createFileSafeStorage(path.join(dir, 'key')), shape: rowsShape });
  return { dir, open };
};
const card = (id: string, status = 'pending', kind = 'question') => ({
  kind,
  id,
  ...(kind === 'question'
    ? { question: { id, title: id, body: '', options: [], expiresAt: null, status, answer: null } }
    : { approval: { id, status, title: id, recipients: [], attachments: [], fields: [] } }),
});

test('a row is written once per id, replaced by the same id, kept in order, and read after a cursor', async (t) => {
  let at = 1000;
  const rows = createMomoRows({ store: real(t).open(), now: () => at });
  await rows.put({ kind: 'question', id: 'q1', at: 5 });
  await rows.put({ kind: 'question', id: 'q2', at: 6 });
  assert.deepEqual(
    rows.list().rows.map((r: any) => r.id),
    ['q1', 'q2'],
  );
  const cursor = rows.list().next;
  await rows.put({ kind: 'question', id: 'q1', at: 5 });
  assert.deepEqual(rows.list(cursor).rows, [], 'the same row again writes nothing');
  assert.equal(rows.list(cursor).next, cursor);
  await rows.put({ kind: 'question', id: 'q1', status: 'answered' });
  const changed = rows.list(cursor);
  assert.deepEqual(
    changed.rows.map((r: any) => [r.id, r.at, r.status]),
    [['q1', 5, 'answered']],
    'a changed row keeps its place in the chat (`at`) and is read again',
  );
  assert.ok(changed.next > cursor);
  at = 2000;
  await rows.put({ kind: 'question', id: 'q3' });
  assert.equal(rows.list().rows.at(-1)?.at, 2000, 'a row with no time is stamped with the clock');
});

test('the cursor never goes back: after a restart, or a move to a machine whose clock is behind, new rows are still read after the old ones', async (t) => {
  const { open } = real(t);
  let at = 10_000;
  const before = createMomoRows({ store: open(), now: () => at });
  await before.put({ kind: 'question', id: 'a' });
  await before.put({ kind: 'question', id: 'b' });
  const seen = before.list().next;
  // a new process over the same file, on a clock that is an hour behind
  at = 10_000 - 3_600_000;
  const after = createMomoRows({ store: open(), now: () => at });
  await after.put({ kind: 'question', id: 'c' });
  const fresh = after.list(seen);
  assert.deepEqual(
    fresh.rows.map((r: any) => r.id),
    ['c'],
    'a client holding the old cursor sees the new row',
  );
  assert.ok(fresh.next > seen);
  assert.deepEqual(
    after.list().rows.map((r: any) => r.id),
    ['a', 'b', 'c'],
  );
});

test('an open card is never evicted: settled rows go first, oldest first, and an open card beyond its own limit ends as void instead of vanishing', async (t) => {
  const store = real(t).open();
  // a store that is already full: one open card first (the oldest of all) and more settled rows than it keeps
  await store.change((v: any) => {
    v.rows = [
      { ...card('keep-pending', 'pending'), written: 1 },
      ...Array.from({ length: ROWS_KEEP + 5 }, (_, i) => ({ kind: 'result', id: `r${i}`, written: 10 + i })),
    ];
  });
  const rows = createMomoRows({ store, now: () => 100_000 });
  await rows.put({ kind: 'result', id: 'newest' });
  const all = store.read().rows.map((r: any) => r.id);
  assert.ok(all.includes('keep-pending'), 'the open card stayed through more than a full store of settled rows');
  assert.equal(all.length, ROWS_KEEP + 1);
  assert.ok(!all.includes('r0') && !all.includes('r5') && all.includes('newest'), 'the oldest settled rows went first');
  // more open cards than the limit: the oldest ends as void, and clients are told (it is written again, after the others)
  const cap = real(t).open();
  await cap.change((v: any) => {
    v.rows = Array.from({ length: PENDING_KEEP + 2 }, (_, i) => ({
      ...card(`p${i}`, 'pending', i % 2 ? 'approval' : 'question'),
      written: 10 + i,
    }));
  });
  const capped = createMomoRows({ store: cap, now: () => 100_000 });
  await capped.put(card('p-last', 'pending'));
  const status = (r: any) => r.question?.status ?? r.approval?.status;
  const everything: any[] = [];
  for (let after = 0, more = true; more; ) {
    const page = capped.list(after, PAGE);
    everything.push(...page.rows);
    after = page.next;
    more = page.more;
  }
  assert.equal(everything.length, PENDING_KEEP + 3, 'nothing vanished');
  assert.deepEqual(
    everything.filter((r) => status(r) === 'void').map((r) => r.id),
    ['p0', 'p1', 'p2'],
    'the three oldest open cards are void now',
  );
  assert.equal(everything.filter((r) => status(r) === 'pending').length, PENDING_KEEP);
  assert.deepEqual(
    everything.slice(-3).map((r: any) => r.id),
    ['p0', 'p1', 'p2'],
    'and they were written again, so a client holding a cursor reads them',
  );
});

test('the lease is checked inside the write and on every read: a Host that stopped being the home neither writes nor shows rows', async (t) => {
  let running: unknown = {};
  const store = real(t).open();
  const rows = createMomoRows({ store, stamp: () => running, hasChat: () => true });
  await rows.put({ kind: 'question', id: 'q' });
  // the home is lost while the write waits for the file: the write itself refuses
  const slow = {
    read: () => store.read(),
    change: async (fn: any) => {
      running = null;
      return store.change(fn);
    },
  };
  assert.equal(await code(createMomoRows({ store: slow, stamp: () => running }).put({ kind: 'question', id: 'late' })), 'momo_home_away');
  assert.deepEqual(
    store.read().rows.map((r: any) => r.id),
    ['q'],
    'nothing was written',
  );
  assert.throws(
    () => rows.list(),
    (e: any) => e.code === 'momo_home_away',
  );
  running = {};
  assert.equal(rows.list().rows.length, 1);
});

test('only the running home writes, and only with a chat; a damaged record reads as empty; listeners hear each row', async (t) => {
  let running: unknown = null;
  let chat = false;
  const rows = createMomoRows({ store: real(t).open(), stamp: () => running, hasChat: () => chat });
  assert.equal(await code(rows.put({ kind: 'question', id: 'q' })), 'momo_home_away');
  running = {};
  assert.equal(await code(rows.put({ kind: 'question', id: 'q' })), 'momo_chat_unavailable');
  chat = true;
  const heard: string[] = [];
  const off = rows.onRow((r: any) => heard.push(r.id));
  rows.onRow(() => {
    throw new Error('a screen failed');
  });
  assert.equal(await code(rows.put({ kind: 'question', id: 'q' })), 'ok');
  off();
  await rows.put({ kind: 'question', id: 'q2' });
  assert.deepEqual(heard, ['q']);
  assert.deepEqual(
    rowsShape({ rows: [null, { id: 1 }, { id: 'x', kind: 'question', written: 'no' }, { id: 'y', kind: 'question', written: 3 }] }).rows
      .length,
    1,
  );
  assert.deepEqual(rowsShape(null), { rows: [] });
});

test('reads come in pages: at most a page, where to ask next, and whether more follow', async (t) => {
  const rows = createMomoRows({ store: real(t).open() });
  for (let i = 0; i < 7; i++) await rows.put({ kind: 'result', id: `r${i}` });
  const first = rows.list(0, 3);
  assert.deepEqual([first.rows.length, first.more], [3, true]);
  const second = rows.list(first.next, 3);
  assert.deepEqual([second.rows.map((r: any) => r.id), second.more], [['r3', 'r4', 'r5'], true]);
  const last = rows.list(second.next, 3);
  assert.deepEqual([last.rows.map((r: any) => r.id), last.more], [['r6'], false]);
  assert.deepEqual(rows.list(last.next), { rows: [], next: last.next, more: false });
  assert.equal(rows.list(0, 1_000_000).rows.length, 7, 'a limit past a page is a page');
});

test('the task core’s card and notice become rows of a bounded size, their ids carry none of a session’s text, and they match the fixture both UIs draw', async (t) => {
  const names = (id: string) => (id === FIXTURE_MACHINE.machineId ? FIXTURE_MACHINE.name : null);
  const row = resultRow(
    {
      itemId: 'task-1',
      settle: 1,
      title: FIXTURE_RESULT.title,
      state: 'done',
      summary: FIXTURE_RESULT.summary,
      files: FIXTURE_RESULT.files,
      evidence: FIXTURE_RESULT.evidence,
      checked: FIXTURE_RESULT.checked,
      machineId: FIXTURE_MACHINE.machineId,
      sessionId: 'claude:session-1',
      untrusted: true,
      actions: [{ action: 'review', label: 'Review' }],
    },
    names,
  );
  assert.deepEqual(row.result, FIXTURE_RESULT);
  assert.equal(row.id, 'result:task-1:1');
  const bare = resultRow({ itemId: 'x', settle: 2 }, () => null);
  assert.deepEqual(
    [bare.result.machine, bare.result.files, bare.result.actions, bare.result.sessionId, bare.result.state],
    [{ machineId: '', name: '' }, [], [], null, 'done'],
  );
  const watch = watchRow(
    { itemId: 'task-2', title: FIXTURE_WATCH.title, detail: FIXTURE_WATCH.detail, machineId: FIXTURE_MACHINE.machineId },
    'task-2:watch:It dropped',
    names,
  );
  assert.deepEqual(watch.watch, FIXTURE_WATCH);
  assert.match(watch.id, /^watch:[0-9a-f]{24}$/, 'the id is a hash: the notice’s own text is not in it');
  assert.equal(watchRow({ itemId: 'task-2' }, 'task-2:watch:It dropped', names).id, watch.id);
  assert.notEqual(watchRow({ itemId: 'task-2' }, 'task-2:watch:Another', names).id, watch.id);
  assert.deepEqual(watchRow({ itemId: 'w' }, 'w', () => null).watch.machine, { machineId: '', name: '' });
  // sizes: every text field is cut, and a long list of files too
  const huge = 'y'.repeat(100_000);
  const big = resultRow(
    {
      itemId: huge,
      settle: 1,
      title: huge,
      summary: huge,
      evidence: huge,
      checked: huge,
      files: Array(500).fill(huge),
      actions: Array(50).fill({ id: huge, label: huge }),
      sessionId: huge,
      machineId: huge,
      state: huge,
    },
    () => huge,
  );
  assert.equal(big.result.summary.length, CAPS.summary);
  assert.equal(big.result.files.length, CAPS.files);
  assert.ok(big.result.files.every((f: string) => f.length === CAPS.file));
  assert.equal(big.result.actions.length, 10);
  assert.ok(JSON.stringify(big).length < 40_000, `a row stays small: ${JSON.stringify(big).length}`);
  assert.equal(watchRow({ itemId: 'a', detail: huge, title: huge, machineId: huge }, 'k', () => huge).watch.detail.length, CAPS.detail);
  // and written through the sink's writer
  const rows = createMomoRows({ store: real(t).open(), nameOf: names });
  await rows.writeRow({ kind: 'result', key: 'task-1:1', body: { itemId: 'task-1', settle: 1 } });
  await rows.writeRow({ kind: 'watch', key: 'task-2:watch:x', body: { itemId: 'task-2' } });
  assert.deepEqual(
    rows.list().rows.map((r: any) => r.kind),
    ['result', 'watch-changed'],
  );
});

test('the seed writes one settled row to the real file, so the travel check opens it', async (t) => {
  const { dir, open } = real(t);
  const rows = createMomoRows({ store: open() });
  await rows.seed();
  await rows.seed();
  assert.deepEqual(
    rows.list().rows.map((r: any) => r.id),
    ['seed:rows'],
  );
  assert.ok(fs.existsSync(path.join(dir, 'chat-rows.json')));
});

test('the fixture holds every kind and every state a card can be in, with distinct ids', () => {
  const ids = FIXTURE_ROWS.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...new Set(FIXTURE_ROWS.map((r) => r.kind))].sort(), ['approval', 'question', 'result', 'watch-changed']);
  for (const status of ['pending', 'approved', 'denied', 'expired', 'void']) assert.ok(ids.includes(`approval:${status}`), status);
  for (const status of ['pending', 'answered', 'expired', 'void']) assert.ok(ids.includes(`question:${status}`), status);
});

test('who may read the rows, and what the wire accepts: an owner device with a live grant, a time and a page size that are numbers', (t) => {
  const home: any = { granted: () => true, rows: createMomoRows({ store: real(t).open() }) };
  const { veils, handlers } = methods({ momo: home });
  const who = (kind: string) => ({ fingerprint: kind, name: kind, kind });
  for (const ok of ['desktop', 'phone']) assert.equal(veils['host.momoRows'](who(ok)), true, ok);
  for (const no of ['cli', 'home']) assert.equal(veils['host.momoRows'](who(no)), false, no);
  assert.equal(veils['host.momoRows'](null), false);
  assert.equal(methods({ momo: { granted: () => false } as any }).veils['host.momoRows'](who('desktop')), false);
  assert.equal(methods({}).veils['host.momoRows'](who('desktop')), false);
  assert.deepEqual(handlers['host.momoRows']({}), { rows: [], next: 0, more: false });
  const parse = wire({ bad: (m: string) => new Error(m) }).methods['host.momoRows'].parse;
  assert.deepEqual(parse({}), {});
  assert.deepEqual(parse({ after: null, limit: null }), {});
  assert.deepEqual(parse({ after: 7, limit: 50 }), { after: 7, limit: 50 });
  for (const bad of [-1, 1.5, '3', NaN]) assert.throws(() => parse({ after: bad }), /not a time/);
  for (const bad of [0, 101, 1.5, '3', NaN]) assert.throws(() => parse({ limit: bad }), /not a number of rows/);
});
