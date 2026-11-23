// The Host outbox (electron/host/outbox.cjs) and approval guard: write-before-wire (A5), two windows (W1), reversed acks and a failed write (W2), a corrupt file (W3), a silent Host (B5), opaque ids (I1), overlapping drains (A1), disposal (A3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
const require = createRequire(import.meta.url);
const { createOutbox, waitingFor, STALLED_MS } = require('../electron/host/outbox.cjs');
const { createApprovalGuard, LIMIT } = require('../electron/host/approvalGuard.cjs');

const world = (t: any) => {
  const clock = installFakeClock(t, 1_000_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reports: Error[] = [];
  const make = () => createOutbox({ dir, report: (e: Error) => reports.push(e) });
  return { clock, dir, reports, make, outbox: make() };
};
const item = (key: string, epoch = 1) => ({ key, epoch, options: { text: key } });
const keys = (o: any, chat = 'c1') => o.pending(chat).map((e: any) => e.key);

test('waitingFor is host unless the registry row is online', () => {
  assert.equal(waitingFor({ status: 'online' }), null);
  assert.equal(waitingFor({ status: 'offline' }), 'host');
  assert.equal(waitingFor({ status: 'needs-setup' }), 'host');
  assert.equal(waitingFor(undefined), 'host');
});

test('add validates, keeps order, and the same key is one message', (t) => {
  const { outbox } = world(t);
  assert.throws(() => outbox.add('c1', { key: '', epoch: 1, options: {} }), /key and an owner epoch/);
  assert.throws(() => outbox.add('c1', { key: 'k', epoch: -1, options: {} }), /key and an owner epoch/);
  assert.throws(() => outbox.add('c1', { key: 'k', epoch: 1.5, options: {} }), /key and an owner epoch/);
  outbox.add('c1', item('a'));
  outbox.add('c1', item('b'));
  outbox.add('c1', item('a'));
  assert.deepEqual(keys(outbox), ['a', 'b']);
  assert.deepEqual(outbox.pending('other'), []);
});

test('restart: three queued messages survive and drain in order, exactly once (A5, done-when)', async (t) => {
  const w = world(t);
  for (const k of ['m1', 'm2', 'm3']) w.outbox.add('c1', item(k));
  const again = w.make();
  const got: string[] = [];
  const r = await again.drain('c1', { online: () => true, send: async (e: any) => void got.push(e.key) });
  assert.deepEqual(got, ['m1', 'm2', 'm3']);
  assert.deepEqual(r, { sent: 3, stopped: null });
  const third = w.make();
  const more: string[] = [];
  await third.drain('c1', { online: () => true, send: async (e: any) => void more.push(e.key) });
  assert.deepEqual(more, [], 'sent entries are not sent again');
  assert.deepEqual(keys(third), ['m1', 'm2', 'm3']);
  third.ack('c1', ['m1', 'm2', 'm3']);
  assert.deepEqual(keys(w.make()), []);
});

test('an offline Host sends nothing and keeps everything; going offline mid-drain stops there', async (t) => {
  const { outbox } = world(t);
  outbox.add('c1', item('a'));
  outbox.add('c1', item('b'));
  assert.deepEqual(await outbox.drain('c1', { online: () => false, send: async () => assert.fail('sent while offline') }), {
    sent: 0,
    stopped: 'offline',
  });
  let up = true;
  const got: string[] = [];
  const r = await outbox.drain('c1', {
    online: () => up,
    send: async (e: any) => {
      got.push(e.key);
      up = false;
    },
  });
  assert.deepEqual(r, { sent: 1, stopped: 'offline' });
  assert.deepEqual(got, ['a']);
});

test('stale_epoch stops the drain, opens the continue dialog and drops nothing', async (t) => {
  const { outbox } = world(t);
  for (const k of ['a', 'b', 'c']) outbox.add('c1', item(k));
  const stale: string[] = [];
  const r = await outbox.drain('c1', {
    online: () => true,
    send: async (e: any) => {
      if (e.key === 'b') throw Object.assign(new Error('stale'), { code: 'stale_epoch' });
    },
    onStale: (e: any) => stale.push(e.key),
  });
  assert.equal(r.stopped, 'stale_epoch');
  assert.deepEqual(stale, ['b']);
  assert.deepEqual(
    outbox.pending('c1').map((e: any) => [e.key, e.state]),
    [
      ['a', 'sent'],
      ['b', 'queued'],
      ['c', 'queued'],
    ],
  );
  const quiet = await outbox.drain('c1', {
    online: () => true,
    send: async () => {
      throw Object.assign(new Error('stale'), { code: 'stale_epoch' });
    },
  });
  assert.equal(quiet.stopped, 'stale_epoch', 'onStale is optional');
});

test('a failed send keeps the message queued and a retry works (W2)', async (t) => {
  const { outbox } = world(t);
  outbox.add('c1', item('a'));
  const failed = await outbox.drain('c1', {
    online: () => true,
    send: async () => {
      throw new Error('tunnel down');
    },
  });
  assert.equal(failed.stopped, 'failed');
  assert.match(failed.error.message, /tunnel down/);
  const ok = await outbox.drain('c1', { online: () => true, send: async () => undefined });
  assert.deepEqual(ok, { sent: 1, stopped: null });
});

test('W1: two windows add before either refreshes; both survive, and an ack of one leaves the other', (t) => {
  const w = world(t);
  const windowA = w.make();
  const windowB = w.make();
  windowA.pending('c1');
  windowB.pending('c1');
  windowA.add('c1', item('fromA'));
  windowB.add('c1', item('fromB'));
  assert.deepEqual(keys(w.make()), ['fromA', 'fromB']);
  windowA.ack('c1', ['fromB', 'unknown']);
  assert.deepEqual(keys(w.make()), ['fromA']);
  windowB.ack('c1', ['nothing']);
  assert.deepEqual(keys(w.make()), ['fromA']);
});

test('the user can delete a queued bubble, not one already sent', async (t) => {
  const { outbox } = world(t);
  outbox.add('c1', item('a'));
  outbox.add('c1', item('b'));
  assert.equal(outbox.remove('c1', 'missing'), false);
  assert.equal(outbox.remove('c1', 'b'), true);
  await outbox.drain('c1', { online: () => true, send: async () => undefined });
  assert.equal(outbox.remove('c1', 'a'), false);
  assert.deepEqual(keys(outbox), ['a']);
});

test('W2: a failed write keeps nothing in memory or on disk, and a retry succeeds', (t) => {
  const w = world(t);
  w.outbox.add('c1', item('a'));
  const orig = fs.writeFileSync;
  (fs as any).writeFileSync = () => {
    throw new Error('disk full');
  };
  try {
    assert.throws(() => w.outbox.add('c1', item('b')), /disk full/);
  } finally {
    (fs as any).writeFileSync = orig;
  }
  assert.deepEqual(keys(w.outbox), ['a']);
  assert.deepEqual(keys(w.make()), ['a']);
  w.outbox.add('c1', item('b'));
  assert.deepEqual(keys(w.make()), ['a', 'b']);
});

test('a write that fails after the send leaves the message queued under the same key (no false success)', async (t) => {
  const w = world(t);
  w.outbox.add('c1', item('a'));
  const orig = fs.writeFileSync;
  const sentKeys: string[] = [];
  const r = await w.outbox.drain('c1', {
    online: () => true,
    send: async (e: any) => {
      sentKeys.push(e.key);
      (fs as any).writeFileSync = () => {
        throw new Error('disk full');
      };
    },
  });
  (fs as any).writeFileSync = orig;
  assert.equal(r.stopped, 'failed');
  assert.equal(w.reports.length, 1);
  assert.equal(w.outbox.pending('c1')[0].state, 'queued');
  await w.outbox.drain('c1', { online: () => true, send: async (e: any) => void sentKeys.push(e.key) });
  assert.deepEqual(sentKeys, ['a', 'a']);
});

test('W3: a corrupt file keeps the entries already known and is never overwritten', (t) => {
  const w = world(t);
  w.outbox.add('c1', item('a'));
  const file = fs.readdirSync(w.dir).find((f) => f.endsWith('.json'))!;
  fs.writeFileSync(path.join(w.dir, file), '{not json');
  assert.deepEqual(keys(w.outbox), ['a']);
  assert.equal(w.reports.length, 1);
  assert.throws(
    () => w.outbox.add('c1', item('b')),
    (e: any) => e.code === 'outbox_unreadable',
  );
  assert.equal(fs.readFileSync(path.join(w.dir, file), 'utf8'), '{not json', 'the damaged file is not replaced');
  assert.deepEqual(keys(w.outbox), ['a']);
  fs.writeFileSync(path.join(w.dir, file), JSON.stringify({ version: 1, chatId: 'c1', entries: [] }));
  w.outbox.add('c1', item('b'));
  assert.deepEqual(keys(w.make()), ['b'], 'a repaired file is usable again');
});

test('W3: a corrupt file nobody has read is refused, not treated as empty', (t) => {
  const w = world(t);
  w.outbox.add('c1', item('a'));
  const file = fs.readdirSync(w.dir).find((f) => f.endsWith('.json'))!;
  fs.writeFileSync(path.join(w.dir, file), JSON.stringify({ version: 1, chatId: 'c1', entries: [{ key: 7 }] }));
  const fresh = w.make();
  assert.throws(
    () => fresh.add('c1', item('b')),
    (e: any) => e.code === 'outbox_unreadable',
  );
  assert.throws(
    () => fresh.pending('c1'),
    (e: any) => e.code === 'outbox_unreadable',
  );
});

test('I1: ids with delimiters and escapes get their own files, and a file holding another id is refused', (t) => {
  const w = world(t);
  const ids = ['a/b', 'a\\b', '../x', 'a"b', 'a b'];
  for (const id of ids) w.outbox.add(id, item(`for ${id}`));
  for (const id of ids) assert.deepEqual(keys(w.make(), id), [`for ${id}`]);
  assert.equal(fs.readdirSync(w.dir).length, ids.length);
  const [first] = fs.readdirSync(w.dir);
  const body = JSON.parse(fs.readFileSync(path.join(w.dir, first), 'utf8'));
  fs.writeFileSync(path.join(w.dir, first), JSON.stringify({ ...body, chatId: 'someone else' }));
  assert.equal(
    ids.filter((id) => {
      try {
        w.make().pending(id);
        return false;
      } catch {
        return true;
      }
    }).length,
    1,
  );
});

test('B5: a Host that answers nothing after sent keeps the item sent, never re-sends it, and is reported after the wait', async (t) => {
  const w = world(t);
  w.outbox.add('c1', item('a'));
  await w.outbox.drain('c1', { online: () => true, send: async () => undefined });
  assert.deepEqual(w.outbox.stalled('c1'), []);
  w.clock.advance(STALLED_MS - 1);
  assert.deepEqual(w.outbox.stalled('c1'), []);
  w.clock.advance(1);
  assert.deepEqual(w.outbox.stalled('c1'), ['a']);
  assert.deepEqual(w.outbox.stalled('c1', 5), ['a']);
  w.outbox.add('c1', item('q'));
  assert.deepEqual(w.outbox.stalled('c1'), ['a'], 'a queued item is waiting, not stalled');
  const again: string[] = [];
  await w.outbox.drain('c1', { online: () => true, send: async (e: any) => void again.push(e.key) });
  assert.deepEqual(again, ['q']);
  w.outbox.ack('c1', ['a']);
  assert.deepEqual(w.outbox.stalled('c1'), []);
});

test('A1: two drains at once send each message once; a later drain after it settles works', async (t) => {
  const { outbox } = world(t);
  outbox.add('c1', item('a'));
  let release: () => void = () => undefined;
  const sent: string[] = [];
  const send = (e: any) =>
    new Promise<void>((resolve) => {
      sent.push(e.key);
      release = resolve;
    });
  const first = outbox.drain('c1', { online: () => true, send });
  const second = outbox.drain('c1', { online: () => true, send });
  assert.equal(first, second);
  release();
  await first;
  assert.deepEqual(sent, ['a']);
  outbox.add('c1', item('b'));
  const next = outbox.drain('c1', { online: () => true, send: async (e: any) => void sent.push(e.key) });
  assert.notEqual(next, first);
  await next;
  assert.deepEqual(sent, ['a', 'b']);
});

test('A3: after dispose a drain starts nothing', async (t) => {
  const { outbox } = world(t);
  outbox.add('c1', item('a'));
  outbox.dispose();
  assert.deepEqual(await outbox.drain('c1', { online: () => true, send: async () => assert.fail('sent after dispose') }), {
    sent: 0,
    stopped: 'offline',
  });
});

test('a message deleted while it is being sent is not brought back by the sent mark', async (t) => {
  const { outbox } = world(t);
  outbox.add('c1', item('a'));
  outbox.add('c1', item('b'));
  const got: string[] = [];
  await outbox.drain('c1', {
    online: () => true,
    send: async (e: any) => {
      got.push(e.key);
      if (e.key === 'a') outbox.ack('c1', ['a']);
    },
  });
  assert.deepEqual(got, ['a', 'b']);
  assert.deepEqual(
    outbox.pending('c1').map((e: any) => [e.key, e.state]),
    [['b', 'sent']],
  );
});

test('B5: three consecutive approval timeouts pause the run once; an answer in between starts the count over', () => {
  const paused: string[] = [];
  const g = createApprovalGuard({ pause: (id: string) => void paused.push(id) });
  assert.equal(LIMIT, 3);
  assert.equal(g.timedOut('c1'), false);
  assert.equal(g.timedOut('c1'), false);
  g.answered('c1');
  assert.equal(g.timedOut('c1'), false);
  assert.equal(g.timedOut('c1'), false);
  assert.equal(g.timedOut('c1'), true);
  assert.equal(g.timedOut('c1'), true);
  assert.deepEqual(paused, ['c1']);
  assert.equal(g.isPaused('c1'), true);
  assert.equal(g.isPaused('c2'), false);
  g.resumed('c1');
  assert.equal(g.isPaused('c1'), false);
  assert.equal(g.timedOut('c1'), false);
});

test('a pause that fails does not count as paused and is tried again at the next timeout (A2)', () => {
  let fail = true;
  const seen: Error[] = [];
  const g = createApprovalGuard({
    pause: () => {
      if (fail) throw new Error('no');
    },
    limit: 1,
    report: (e: Error) => seen.push(e),
  });
  assert.equal(g.timedOut('c1'), false);
  assert.equal(seen.length, 1);
  assert.equal(g.isPaused('c1'), false);
  fail = false;
  assert.equal(g.timedOut('c1'), true);
});

test('without a report callback a failed pause or damaged file still behaves the same', (t) => {
  const g = createApprovalGuard({
    pause: () => {
      throw new Error('no');
    },
    limit: 1,
  });
  assert.equal(g.timedOut('c1'), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const o = createOutbox({ dir });
  o.add('c1', item('a'));
  fs.writeFileSync(path.join(dir, fs.readdirSync(dir)[0]), '{bad');
  assert.throws(
    () => o.add('c1', item('b')),
    (e: any) => e.code === 'outbox_unreadable',
  );
});

test('a message deleted while an earlier one is in flight is not sent (A3)', async (t) => {
  const { outbox } = world(t);
  outbox.add('c1', item('a'));
  outbox.add('c1', item('b'));
  const got: string[] = [];
  await outbox.drain('c1', {
    online: () => true,
    send: async (e: any) => {
      got.push(e.key);
      outbox.remove('c1', 'b');
    },
  });
  assert.deepEqual(got, ['a']);
});

test('rebase moves queued messages to the new epoch so a drain stops being refused', async (t) => {
  const { outbox } = world(t);
  outbox.add('c1', item('a', 1));
  outbox.add('c1', item('b', 2));
  assert.throws(() => outbox.rebase('c1', -1), /owner epoch/);
  const seen: number[] = [];
  const refuse = async (e: any) => {
    seen.push(e.epoch);
    if (e.epoch < 2) throw Object.assign(new Error('stale'), { code: 'stale_epoch' });
  };
  assert.equal((await outbox.drain('c1', { online: () => true, send: refuse })).stopped, 'stale_epoch');
  outbox.rebase('c1', 2);
  outbox.rebase('c1', 2);
  assert.deepEqual(await outbox.drain('c1', { online: () => true, send: refuse }), { sent: 2, stopped: null });
  assert.deepEqual(seen, [1, 2, 2]);
});

test('requeue returns a sent message the Host never recorded to the queue under its own key', async (t) => {
  const { outbox } = world(t);
  outbox.add('c1', item('a'));
  await outbox.drain('c1', { online: () => true, send: async () => undefined });
  outbox.requeue('c1', ['nope']);
  assert.equal(outbox.pending('c1')[0].state, 'sent');
  outbox.requeue('c1', ['a']);
  assert.deepEqual(
    outbox.pending('c1').map((e: any) => [e.key, e.state, e.sentAt]),
    [['a', 'queued', null]],
  );
  const got: string[] = [];
  await outbox.drain('c1', { online: () => true, send: async (e: any) => void got.push(e.key) });
  assert.deepEqual(got, ['a']);
});
