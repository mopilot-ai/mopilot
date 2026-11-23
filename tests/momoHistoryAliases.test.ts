// MoMo's search aliases for its past chats (#2999 P2): the index matches a chunk by its aliases but never returns them
// (electron/momo/historyIndex.cjs), and the writer (electron/momo/historyAliases.cjs) sends the newest chunks without
// aliases to the cheap model a batch at a time, within the day's alias tokens, never on battery, at the brain's limit,
// while MoMo is off or after it was reset; a turn the reply leaves out is tried again once, a reply with no terms at all
// marks nothing and a few in a row stop the batches, a chat that never answers or can't be sent to is given up, and
// keyword search works the same without any aliases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { HistoryIndex } = require('../electron/momo/historyIndex.cjs');
const { createHistoryAliases, BATCH, STALE_MS, MAX_TRIES, TICK_MS, MAX_EMPTY_REPLIES } = require('../electron/momo/historyAliases.cjs');

const chunk = (turnId: string, at: number, user: string, assistant = 'Noted.', chatId = 'c1') => ({
  chatId,
  turnId,
  at,
  harness: 'claude',
  kind: 'main',
  user,
  assistant,
});
const index = () => new HistoryIndex({ dir: '/nonexistent', safeStorage: null });
const ids = (r: any[]) => r.map((c) => c.turnId);

test('a chunk is found by its aliases, which are never returned; the newest without aliases come first', () => {
  const ix = index();
  ix.add([chunk('t1', 1, 'Bob rents me the flat on Elm Street'), chunk('t2', 2, 'The dentist is on Wednesday'), chunk('t3', 3, 'hi')]);
  // "房东" (landlord) is not in the turn: no match before its aliases
  assert.deepEqual(ids(ix.search('房东')), []);
  assert.deepEqual(ids(ix.needingAliases(2)), ['t3', 't2'], 'newest first');
  assert.equal(
    ix.setAliases([
      { chatId: 'c1', turnId: 't1', aliases: 'landlord 房东 lessor' },
      { chatId: 'c1', turnId: 't3', aliases: '' },
    ]),
    2,
  );
  assert.deepEqual(ids(ix.search('房东是谁')), ['t1']);
  assert.deepEqual(ids(ix.search('landlord')), ['t1']);
  assert.deepEqual(ids(ix.search('Elm Street')), ['t1'], 'its own words still match');
  const [hit] = ix.search('lessor');
  assert.deepEqual(Object.keys(hit).sort(), ['assistant', 'at', 'chatId', 'harness', 'kind', 'turnId', 'user']);
  assert.ok(!JSON.stringify(hit).includes('lessor'), 'aliases only match');
  assert.deepEqual(ids(ix.needingAliases(5)), ['t2'], "'' marks a chunk tried");
  // set again: the new aliases replace the old
  ix.setAliases([{ chatId: 'c1', turnId: 't1', aliases: 'tenant' }]);
  assert.deepEqual(ids(ix.search('lessor')), []);
  assert.deepEqual(ids(ix.search('tenant')), ['t1']);
  // a chunk no longer there is skipped; a deleted chat takes its aliases with it
  assert.equal(
    ix.setAliases([
      { chatId: 'gone', turnId: 'x', aliases: 'a' },
      { chatId: 'c1', turnId: 't2', aliases: 7 as any },
    ]),
    1,
  );
  ix.removeChat('c1');
  assert.equal(ix.count(), 0);
  assert.equal(ix.db.prepare('SELECT count(*) AS n FROM aliases').get().n, 0);
});

test('an index that cannot open has no chunks to alias and sets none', () => {
  const ix = new HistoryIndex({
    dir: '/nonexistent',
    open: () => {
      throw new Error('no sqlite');
    },
  });
  assert.deepEqual(ix.needingAliases(5), []);
  assert.equal(ix.setAliases([{ chatId: 'c', turnId: 't', aliases: 'x' }]), 0);
});

/** The writer over a real index, with every outside part recorded. */
function writer(
  o: {
    allowed?: () => boolean;
    battery?: boolean;
    held?: boolean;
    left?: number;
    brain?: any;
    now?: () => number;
    gate?: { spend?: Promise<void>; brain?: Promise<void>; stale?: Promise<void> };
  } = {},
) {
  const ix = index();
  const started: any[] = [];
  const sent: any[] = [];
  const discarded: string[] = [];
  const spent: number[] = [];
  let n = 0;
  let ticker: any = null;
  const w = createHistoryAliases({
    index: ix,
    allowed: o.allowed ?? (() => true),
    brain: async () => {
      await o.gate?.brain;
      return 'brain' in o ? o.brain : { harness: 'claude', model: 'haiku' };
    },
    atLimit: () => o.held === true,
    startChat: async (brain: any, tag: any) => (started.push([brain, tag]), `a${++n}`),
    send: async (id: string, text: string) => void sent.push([id, text]),
    discardChat: async (id: string) => {
      discarded.push(id);
      await o.gate?.stale;
    },
    budget: {
      spend: async (_k: string, t: number) => {
        spent.push(t);
        await o.gate?.spend;
      },
      left: () => o.left ?? 1e9,
    },
    onBattery: () => o.battery === true,
    now: o.now,
    timers: {
      setInterval: (fn: any, ms: number) => ((ticker = { fn, ms }), ticker),
      clearInterval: () => {
        ticker = null;
      },
    },
  });
  return { ix, w, started, sent, discarded, spent, ticker: () => ticker };
}

test('a batch goes to a data-only chat; the reply’s terms land on its chunks and the chat goes', async () => {
  const t = writer();
  t.ix.add([chunk('t1', 1, 'Bob rents me the flat'), chunk('t2', 2, '牙医约在周三')]);
  assert.equal(await t.w.tick(), true);
  assert.deepEqual(t.started, [[{ harness: 'claude', model: 'haiku' }, { momo: 'aliases' }]]);
  assert.equal(t.sent[0][0], 'a1');
  assert.match(t.sent[0][1], /\[1\] User: 牙医/, 'newest first');
  assert.equal(t.w.pending(), 2);
  assert.equal(await t.w.tick(), false, 'one batch at a time');
  assert.equal(await t.w.finished({ chatId: 'other', text: '{}' }), null, 'another chat is not the batch');
  assert.equal(await t.w.finished({ chatId: 'a1', text: '{"1":"dentist Wednesday","2":"landlord 房东"}' }), 2);
  assert.deepEqual(t.discarded, ['a1']);
  assert.deepEqual(ids(t.ix.search('landlord')), ['t1']);
  assert.deepEqual(ids(t.ix.search('dentist')), ['t2']);
  assert.equal(t.spent.length, 2, 'the prompt and the reply are counted');
  assert.equal(await t.w.tick(), false, 'nothing left');
  assert.equal(t.started.length, 1);
});

test('no batch on battery, at the brain’s limit, without a brain, while MoMo is off, or past the day’s tokens', async () => {
  for (const o of [{ battery: true }, { held: true }, { brain: null }, { allowed: () => false }, { left: 10 }]) {
    const t = writer(o);
    t.ix.add([chunk('t1', 1, 'hello there')]);
    assert.equal(await t.w.tick(), false, JSON.stringify(o));
    assert.equal(t.sent.length, 0);
  }
  const empty = writer();
  assert.equal(await empty.w.tick(), false, 'nothing to alias: no chat');
  assert.equal(empty.started.length, 0);
});

test('a turn the reply leaves out is tried again, then marked with none; a batch is at most BATCH chunks', async () => {
  const t = writer();
  t.ix.add(Array.from({ length: BATCH + 1 }, (_, i) => chunk(`t${i}`, i, `turn ${i}`)));
  for (let k = 0; k < MAX_TRIES; k++) {
    assert.equal(await t.w.tick(), true);
    assert.equal(t.w.pending(), BATCH);
    await t.w.finished({ chatId: `a${k + 1}`, text: '{}' });
  }
  assert.deepEqual(ids(t.ix.needingAliases(5)), ['t0']);
});

test('a reply with no terms at all marks nothing; a few in a row stop the batches until start()', async () => {
  const t = writer();
  t.ix.add([chunk('t1', 1, 'hello there')]);
  for (let k = 0; k < MAX_EMPTY_REPLIES; k++) {
    assert.equal(await t.w.tick(), true);
    assert.equal(await t.w.finished({ chatId: `a${k + 1}`, text: k ? 'You have hit your usage limit.' : undefined }), 0);
  }
  assert.deepEqual(ids(t.ix.needingAliases(5)), ['t1'], 'still waiting for its aliases');
  assert.equal(await t.w.tick(), false, 'stopped');
  t.w.start();
  assert.equal(await t.w.tick(), true, 'started again');
  await t.w.finished({ chatId: `a${MAX_EMPTY_REPLIES + 1}`, text: '{"1":"greeting"}' });
  assert.deepEqual(ids(t.ix.search('greeting')), ['t1']);
  t.w.cancelAll();
});

test('a batch that cannot be sent is given up at once; one whose chat was deleted never lands', async () => {
  const t = writer();
  t.ix.add([chunk('t1', 1, 'hello there')]);
  let fail = true;
  const u = createHistoryAliases({
    index: t.ix,
    allowed: () => true,
    brain: async () => ({ harness: 'claude' }),
    atLimit: () => false,
    startChat: async () => 'b1',
    send: async () => {
      if (fail) throw new Error('harness gone');
    },
    discardChat: (id: string) => void t.discarded.push(id),
    budget: { spend: async () => {}, left: () => 1e9 },
  });
  await assert.rejects(u.tick(), /harness gone/);
  assert.deepEqual(t.discarded, ['b1']);
  assert.equal(u.pending(), 0);
  fail = false;
  assert.equal(await u.tick(), true, 'the next tick starts another at once');
  u.deleted('other');
  assert.equal(u.pending(), 1);
  u.deleted('b1');
  assert.equal(u.pending(), 0);
  assert.equal(await u.finished({ chatId: 'b1', text: '{"1":"greeting"}' }), null);
  assert.deepEqual(ids(t.ix.needingAliases(5)), ['t1']);
});

test('MoMo going off drops the batch under way and stops the ticks; one turned off while its chat started is discarded', async () => {
  const t = writer();
  t.ix.add([chunk('t1', 1, 'hello there')]);
  t.w.start();
  t.w.start();
  assert.equal(t.ticker().ms, TICK_MS);
  t.ticker().fn();
  await waitFor(() => t.sent.length, 'the batch to be sent');
  t.w.cancelAll();
  assert.equal(t.ticker(), null);
  assert.deepEqual(t.discarded, ['a1'], 'the batch’s chat goes');
  assert.equal(await t.w.finished({ chatId: 'a1', text: '{"1":"greeting"}' }), null, 'it never lands');
  assert.equal(t.ix.needingAliases(5).length, 1);
  t.w.cancelAll();
  // turned off while the chat started: allowed at the check, not after
  let checks = 0;
  const u = writer({ allowed: () => ++checks === 1 });
  u.ix.add([chunk('t1', 1, 'hello there')]);
  assert.equal(await u.w.tick(), false);
  assert.deepEqual(u.discarded, ['a1']);
  assert.equal(u.sent.length, 0);
  // a reset (cancelAll) while the chat started: discarded, nothing sent
  const v = writer();
  v.ix.add([chunk('t1', 1, 'hello there')]);
  const started = v.w.tick();
  v.w.cancelAll();
  assert.equal(await started, false);
  assert.equal(v.sent.length, 0);
});

/** A promise the test lets go of when it chooses. */
function held() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

test('a reset, MoMo going off or the chat deleted while the prompt is counted: nothing is sent and the chat goes', async () => {
  for (const cut of ['cancelAll', 'off', 'deleted'] as const) {
    const g = held();
    let on = true;
    const t = writer({ gate: { spend: g.promise }, allowed: () => on });
    t.ix.add([chunk('t1', 1, 'hello there')]);
    const ticking = t.w.tick();
    await waitFor(() => t.spent.length, 'the batch to be spent');
    assert.equal(t.spent.length, 1, cut);
    if (cut === 'cancelAll') t.w.cancelAll();
    else if (cut === 'off') on = false;
    else t.w.deleted('a1');
    g.release();
    assert.equal(await ticking, false, cut);
    assert.equal(t.sent.length, 0, `${cut}: never sent`);
    assert.ok(t.discarded.includes('a1'), `${cut}: its chat goes`);
    assert.equal(t.w.pending(), 0, cut);
    if (cut !== 'cancelAll') {
      // the slot is free: once MoMo is on again the next tick starts another batch
      on = true;
      assert.equal(await t.w.tick(), true, cut);
      assert.equal(t.sent[0][0], 'a2', cut);
    }
    t.w.cancelAll();
  }
});

test('a reset while the brain is picked or a stale batch is dropped starts no chat', async () => {
  const g = held();
  const t = writer({ gate: { brain: g.promise } });
  t.ix.add([chunk('t1', 1, 'hello there')]);
  const ticking = t.w.tick();
  await new Promise((r) => setTimeout(r, 2));
  t.w.cancelAll();
  g.release();
  assert.equal(await ticking, false);
  assert.equal(t.started.length, 0);
  // a stale batch is dropped, then a reset comes before the next is started
  let at = 1000;
  const s = held();
  let gateStale = false;
  const u = writer({
    now: () => at,
    gate: {
      get stale() {
        return gateStale ? s.promise : undefined;
      },
    } as any,
  });
  u.ix.add([chunk('t1', 1, 'hello there')]);
  assert.equal(await u.w.tick(), true);
  at += STALE_MS;
  gateStale = true;
  const next = u.w.tick();
  await new Promise((r) => setTimeout(r, 2));
  u.w.cancelAll();
  s.release();
  assert.equal(await next, false);
  assert.equal(u.started.length, 1, 'no second chat');
});

test('a reply that comes after MoMo went off sets nothing', async () => {
  let on = true;
  const t = writer({ allowed: () => on });
  t.ix.add([chunk('t1', 1, 'hello there')]);
  await t.w.tick();
  on = false;
  assert.equal(await t.w.finished({ chatId: 'a1', text: '{"1":"greeting"}' }), 0);
  assert.deepEqual(t.discarded, ['a1']);
  assert.equal(t.ix.needingAliases(5).length, 1);
});

test('a batch whose chat never answers is given up after STALE_MS, and the next tick starts another', async () => {
  let at = 1000;
  const t = writer({ now: () => at });
  t.ix.add([chunk('t1', 1, 'hello there')]);
  await t.w.tick();
  at += STALE_MS - 1;
  assert.equal(await t.w.tick(), false);
  at += 1;
  assert.equal(await t.w.tick(), true);
  assert.deepEqual(t.discarded, ['a1']);
  assert.equal(t.sent[1][0], 'a2');
  t.w.cancelAll();
});

test('a tick that fails is noted, never thrown', async () => {
  const t = writer();
  t.ix.add([chunk('t1', 1, 'hello there')]);
  t.ix.needingAliases = () => {
    throw new Error('db gone');
  };
  t.w.start();
  t.ticker().fn();
  await new Promise((r) => setTimeout(r, 5));
  t.w.cancelAll();
});
