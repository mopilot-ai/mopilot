// MoMo's suggestion store and ranking (A7, electron/momo/suggestions.cjs and suggestionRank.cjs): a suggestion is validated and clipped; at most 3 are added a day and 6 are shown; one thing is told once and again only when its source state changes (key over source, id and kind); it expires after 7 days; Add keeps it as the user's task for a month; Hide removes it and halves what its kind counts for; Start takes it out, runs the caller's send and puts it back when the send fails; junk in the kept file is dropped.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../electron/momo/suggestions.cjs');
const R = require('../electron/momo/suggestionRank.cjs');

const DAY = 86_400_000;
const H = 3_600_000;
const T0 = new Date(2026, 10, 16, 9, 0).getTime();

function rig() {
  const clock = { t: T0 };
  const now = () => clock.t;
  let n = 0;
  const storage = S.memoryStorage({ now });
  const store = S.createSuggestions({ storage, now, newId: () => `s${++n}` });
  return { clock, storage, store };
}

const one = (over: Record<string, unknown> = {}) => ({
  title: 'Reply to Sam about the lease',
  why: 'He asked on Monday and the lease ends Friday.',
  source: 'Mail: Sam, Lease renewal',
  step: 'Draft a reply to Sam',
  from: 'mail',
  ref: 'thread-1',
  kind: 'reply',
  state: 'm1',
  ...over,
});

const refused = async (p: Promise<unknown>, code: string, text?: RegExp) =>
  p.then(
    () => assert.fail('should have been refused'),
    (e: any) => {
      assert.equal(e.code, code);
      assert.ok(e instanceof S.SuggestionError);
      if (text) assert.match(e.message, text);
    },
  );

test('an added suggestion has its id, times and the main channel, and is listed with its score', async () => {
  const { store } = rig();
  const s = await store.add(one());
  assert.deepEqual([s.id, s.channel, s.status, s.createdAt, s.expiresAt], ['s1', 'main', 'new', T0, T0 + 7 * DAY]);
  const { suggestions, shown } = store.list();
  assert.equal(shown, 6);
  assert.equal(suggestions.length, 1);
  assert.deepEqual(suggestions[0].inputs, { dueAt: null, cost: 'none', confidence: 'medium' });
  assert.equal(suggestions[0].score.total, 0.3 * 0.3 * 0.7);
});

test('a channel id is kept, and a bad one is refused', async () => {
  const { store } = rig();
  assert.equal((await store.add(one({ channel: 'ch_0123456789abcdef' }))).channel, 'ch_0123456789abcdef');
  await refused(store.add(one({ ref: 'x', channel: 'no spaces' })), 'bad_args');
  await refused(store.add(one({ ref: 'x2', channel: 'work-2' })), 'bad_args');
  await refused(store.add(one({ ref: 'y', channel: 5 })), 'bad_args');
});

test('every text field is needed, a long reason is refused and the model’s other words are clipped to one line', async () => {
  const { store } = rig();
  for (const field of ['title', 'why', 'source', 'step', 'from', 'ref', 'kind']) {
    await refused(store.add(one({ [field]: '  ' })), 'bad_args', field === 'from' ? /source name/ : new RegExp(field));
  }
  await refused(store.add(null), 'bad_args');
  await refused(store.add(one({ why: 'x'.repeat(241) })), 'bad_args', /240/);
  const s = await store.add(one({ title: `a\n b${'z'.repeat(300)}`, why: 'x'.repeat(240) }));
  assert.equal(s.title.length, 120);
  assert.match(s.title, /^a b/);
  assert.equal(s.why.length, 240);
});

test('the score inputs are checked: cost, confidence and a deadline in milliseconds', async () => {
  const { store } = rig();
  await refused(store.add(one({ cost: 'huge' })), 'bad_args', /cost/);
  await refused(store.add(one({ confidence: 'maybe' })), 'bad_args', /confidence/);
  await refused(store.add(one({ dueAt: 'tomorrow' })), 'bad_args', /dueAt/);
  const s = await store.add(one({ dueAt: T0 + H, cost: 'money', confidence: 'sure' }));
  assert.deepEqual(s.inputs, { dueAt: T0 + H, cost: 'money', confidence: 'sure' });
  // null means no deadline
  assert.equal((await store.add(one({ ref: 'other', dueAt: null }))).inputs.dueAt, null);
});

test('at most 3 are added a day; the next day takes more', async () => {
  const { store, clock } = rig();
  for (const ref of ['a', 'b', 'c']) await store.add(one({ ref }));
  await refused(store.add(one({ ref: 'd' })), 'capped', /3 new/);
  clock.t += DAY;
  assert.equal((await store.add(one({ ref: 'd' }))).title.length > 0, true);
  assert.equal(store.list().suggestions.length, 4);
});

test('the same thing is told once and again only when its source state changes, which replaces the earlier one', async () => {
  const { store, clock } = rig();
  const first = await store.add(one());
  await refused(store.add(one()), 'duplicate', /already suggested/);
  // another kind or another thread is another item
  await store.add(one({ kind: 'prepare' }));
  clock.t += 1000;
  const again = await store.add(one({ state: 'm2' }));
  assert.notEqual(again.id, first.id);
  assert.deepEqual(
    store
      .list()
      .suggestions.filter((x: any) => x.ref === 'thread-1' && x.kind === 'reply')
      .map((x: any) => x.id),
    [again.id],
  );
  // the key is not case sensitive
  await refused(store.add(one({ state: 'm2', from: 'MAIL', kind: 'Reply' })), 'duplicate');
});

test('a hidden or started item is not told again until its source changes, even after it left the list', async () => {
  const { store } = rig();
  const a = await store.add(one());
  await store.act(a.id, 'hide');
  await refused(store.add(one()), 'duplicate');
  const b = await store.add(one({ ref: 'thread-2' }));
  await store.act(b.id, 'start', async () => undefined);
  await refused(store.add(one({ ref: 'thread-2' })), 'duplicate');
  assert.equal((await store.add(one({ ref: 'thread-2', state: 'm9' }))).state, 'm9');
});

test('a suggestion expires after 7 days; what was told is remembered for 30', async () => {
  const { store, clock } = rig();
  await store.add(one());
  clock.t += 7 * DAY - 1;
  assert.equal(store.list().suggestions.length, 1);
  clock.t += 2;
  assert.equal(store.list().suggestions.length, 0);
  await refused(store.add(one()), 'duplicate');
  clock.t += 30 * DAY;
  assert.equal((await store.add(one())).id.startsWith('s'), true);
});

test('Add keeps it as the user’s own for a month and it stays listed as added', async () => {
  const { store, clock } = rig();
  const s = await store.add(one());
  const done = await store.act(s.id, 'add');
  assert.deepEqual([done.id, done.action, done.item.id], [s.id, 'add', s.id]);
  const [kept] = store.list().suggestions;
  assert.equal(kept.status, 'added');
  assert.equal(kept.expiresAt, T0 + 30 * DAY);
  clock.t += 20 * DAY;
  assert.equal(store.list().suggestions.length, 1);
  // a longer life is not cut short
  const long = await store.add(one({ ref: 'later' }));
  clock.t += 6 * DAY;
  await store.act(long.id, 'add');
  assert.equal(store.list().suggestions.find((x: any) => x.id === long.id).expiresAt, clock.t + 30 * DAY);
});

test('Hide removes it and halves what its kind counts for, so the next of that kind ranks lower; the count fades after 30 days', async () => {
  const { store, clock } = rig();
  const a = await store.add(one({ ref: 'a', cost: 'person', confidence: 'high' }));
  const before = store.list().suggestions[0].score;
  assert.equal(before.novelty, 1);
  await store.act(a.id, 'hide');
  assert.equal(store.list().suggestions.length, 0);
  const b = await store.add(one({ ref: 'b', cost: 'person', confidence: 'high' }));
  const after = store.list().suggestions.find((x: any) => x.id === b.id).score;
  assert.equal(after.novelty, 0.5);
  assert.equal(after.total, Math.round(before.total * 0.5 * 1000) / 1000);
  // a second Hide of the same kind halves it again, and the count stops at its cap
  await store.act(b.id, 'hide');
  const again = await store.add(one({ ref: 'b2', cost: 'person', confidence: 'high' }));
  assert.equal(store.list().suggestions.find((x: any) => x.id === again.id).score.novelty, 0.25);
  await store.act(again.id, 'hide');
  // another kind is not counted (the next day: three new a day)
  clock.t += DAY;
  await store.add(one({ ref: 'c', kind: 'prepare' }));
  assert.equal(store.list().suggestions.find((x: any) => x.kind === 'prepare').score.novelty, 1);
  clock.t += 31 * DAY;
  assert.equal(store.list().suggestions.length, 0);
  const fresh = await store.add(one({ ref: 'd', state: 'z' }));
  assert.equal(store.list().suggestions.find((x: any) => x.id === fresh.id).score.novelty, 1);
});

test('the best are listed first: sooner and costlier beat later and cheaper; ties go to the newer', async () => {
  const { store, clock } = rig();
  const low = await store.add(one({ ref: 'low' }));
  const money = await store.add(one({ ref: 'money', cost: 'money', confidence: 'sure', dueAt: T0 + 2 * H }));
  clock.t += 1000;
  const lowNewer = await store.add(one({ ref: 'low2' }));
  assert.deepEqual(
    store.list().suggestions.map((s: any) => s.id),
    [money.id, lowNewer.id, low.id],
  );
});

test('at most 20 are kept: the lowest scores go first', async () => {
  const { store, clock, storage } = rig();
  // seed 20 live ones past the day's cap by writing the store the way a long-running Mac would have
  await storage.change((v: any) => {
    for (let i = 0; i < S.MAX_LIVE; i++)
      v.items.push({
        ...one({ ref: `old${i}` }),
        id: `o${i}`,
        key: `mail|old${i}|reply`,
        channel: 'main',
        createdAt: T0,
        expiresAt: T0 + 7 * DAY,
        status: 'new',
        at: T0,
        inputs: { dueAt: null, cost: 'none', confidence: 'low' },
      });
  });
  clock.t += 1000;
  const best = await store.add(one({ ref: 'best', cost: 'money', confidence: 'sure', dueAt: T0 }));
  const { suggestions } = store.list();
  assert.equal(suggestions.length, S.MAX_LIVE);
  assert.equal(suggestions[0].id, best.id);
});

test('the commitment floor: a commitment in the user’s words that MoMo is sure of never scores below 0.5', () => {
  const sure = R.scoreOf({ dueAt: null, cost: 'commitment', confidence: 'sure' }, { n: 5 }, T0);
  assert.equal(sure.total, R.COMMITMENT_FLOOR);
  const unsure = R.scoreOf({ dueAt: null, cost: 'commitment', confidence: 'high' }, { n: 5 }, T0);
  assert.ok(unsure.total < R.COMMITMENT_FLOOR);
  assert.equal(R.scoreOf({ dueAt: T0 - H, cost: 'commitment', confidence: 'sure' }, undefined, T0).total, 0.9);
});

test('urgency by time to the deadline: past or a day 1, three days 0.8, a week 0.5, later or none 0.3', () => {
  const u = (ms: number | null) => R.urgencyOf(ms, T0);
  assert.deepEqual([u(T0 - DAY), u(T0 + DAY), u(T0 + 3 * DAY), u(T0 + 7 * DAY), u(T0 + 8 * DAY), u(null)], [1, 1, 0.8, 0.5, 0.3, 0.3]);
  assert.equal(R.noveltyOf({ n: 20 }), 0.1);
  assert.equal(R.noveltyOf(undefined), 1);
  assert.ok(R.isCost('money') && !R.isCost('toString') && !R.isCost(3));
  assert.ok(R.isConfidence('sure') && !R.isConfidence('hasOwnProperty'));
});

test('act: only Add, Start or Hide on an id that is there', async () => {
  const { store } = rig();
  const s = await store.add(one());
  await refused(store.act(5, 'add'), 'bad_args');
  await refused(store.act('', 'add'), 'bad_args');
  await refused(store.act(s.id, 'finish'), 'bad_args', /Add, Start or Hide/);
  await refused(store.act('nope', 'hide'), 'gone', /gone/);
  assert.equal(store.list().suggestions.length, 1);
});

test('Start takes it out and runs the caller’s send once with the item; a second Start finds it gone', async () => {
  const { store } = rig();
  const s = await store.add(one());
  const seen: any[] = [];
  const done = await store.act(s.id, 'start', async (item: any) => void seen.push(item.step));
  assert.deepEqual(seen, ['Draft a reply to Sam']);
  assert.equal(done.action, 'start');
  assert.equal(store.list().suggestions.length, 0);
  await refused(
    store.act(s.id, 'start', async () => assert.fail('a second Start must not send')),
    'gone',
  );
  // no send given: nothing to run, the item is still out
  const t = await store.add(one({ ref: 'b' }));
  await store.act(t.id, 'start');
  assert.equal(store.list().suggestions.length, 0);
});

test('a Start whose send fails puts the suggestion back where it was and says why', async () => {
  const { store } = rig();
  const a = await store.add(one({ ref: 'a', cost: 'money', confidence: 'sure' }));
  const b = await store.add(one({ ref: 'b' }));
  await assert.rejects(
    store.act(a.id, 'start', async () => {
      throw new Error('MoMo is paused. Resume it first.');
    }),
    /paused/,
  );
  assert.deepEqual(
    store.list().suggestions.map((x: any) => x.id),
    [a.id, b.id],
  );
});

test('a failed Start does not restore a suggestion that is back already', async () => {
  const { store, storage } = rig();
  const a = await store.add(one());
  await assert.rejects(
    store.act(a.id, 'start', async (item: any) => {
      await storage.change((v: any) => void v.items.push(item));
      throw new Error('late');
    }),
    /late/,
  );
  assert.equal(store.list().suggestions.length, 1);
});

test('what is kept is checked on every read: junk, duplicates, expired items and stale counters are dropped', () => {
  const now = T0;
  const good = {
    id: 'g',
    title: 't',
    why: 'w',
    source: 's',
    step: 'p',
    from: 'mail',
    ref: 'r',
    kind: 'k',
    state: '',
    channel: 'main',
    createdAt: now,
    expiresAt: now + DAY,
    inputs: { dueAt: 'x', cost: 'money', confidence: 'sure' },
    status: 'added',
  };
  const v = S.suggestionsShape(
    {
      items: [
        good,
        { ...good },
        { ...good, id: 'bad-cost', inputs: { cost: 'x', confidence: 'sure' } },
        { ...good, id: 'no-title', title: '' },
        { ...good, id: 'bad-channel', channel: 'a b' },
        { ...good, id: 'expired', expiresAt: now },
        { ...good, id: 'nodates', createdAt: 'x' },
        'junk',
        null,
        { ...good, id: 'plain', status: 'other', at: undefined, inputs: { dueAt: 5, cost: 'none', confidence: 'low' } },
      ],
      told: { a: { state: 's', at: now }, old: { state: 's', at: now - 31 * DAY }, bad: { state: 3, at: now }, worse: 'x' },
      hides: { k: { n: 99, at: now }, old: { n: 1, at: now - 31 * DAY }, zero: { n: 0, at: now }, frac: { n: 1.5, at: now }, x: 'y' },
      today: { day: '2026-11-16', n: 2 },
    },
    now,
  );
  assert.deepEqual(
    v.items.map((x: any) => [x.id, x.status, x.inputs.dueAt, x.at]),
    [
      ['g', 'added', null, now],
      ['plain', 'new', 5, now],
    ],
  );
  assert.deepEqual(Object.keys(v.told), ['a']);
  assert.deepEqual(v.hides, { k: { n: R.MAX_HIDES, at: now } });
  assert.deepEqual(v.today, { day: '2026-11-16', n: 2 });
  for (const junk of [null, 5, [], { items: 'x', told: [], hides: 3, today: { day: 1, n: -1 } }]) {
    assert.deepEqual(S.suggestionsShape(junk, now), { v: 1, items: [], told: {}, hides: {}, done: {}, today: { day: '', n: 0 } });
  }
  assert.equal(
    S.suggestionsShape({ items: Array.from({ length: 30 }, (_, i) => ({ ...good, id: `i${i}` })) }, now).items.length,
    S.MAX_LIVE,
  );
  const many = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`k${i}`, { state: 's', at: now - i }]));
  assert.equal(Object.keys(S.suggestionsShape({ told: many }, now).told).length, 500);
});

test('what the user did to a suggestion that is gone from the list is told for 7 days, so a card of a brief reads the same after a restart', async () => {
  const { store, clock } = rig();
  const a = await store.add(one({ ref: 'a' }));
  const b = await store.add(one({ ref: 'b' }));
  const c = await store.add(one({ ref: 'c' }));
  await store.act(a.id, 'hide');
  await store.act(b.id, 'start', async () => undefined);
  await store.act(c.id, 'add');
  // Add keeps it listed: nothing was done to it that takes it away
  assert.deepEqual(store.list().done, { [a.id]: 'hide', [b.id]: 'start' });
  // a Start that failed was not done
  clock.t += DAY;
  const d = await store.add(one({ ref: 'd' }));
  await assert.rejects(
    store.act(d.id, 'start', async () => Promise.reject(new Error('no'))),
    /no/,
  );
  assert.equal(store.list().done[d.id], undefined);
  clock.t += 7 * DAY;
  assert.deepEqual(store.list().done, {});
});

test('the kept outcomes are checked: a bad action, an old one, a long id and a surplus are dropped', () => {
  const at = T0;
  const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`s${i}`, { action: 'hide', at: at - i }]));
  const v = S.suggestionsShape(
    {
      done: {
        ...many,
        x: { action: 'add', at },
        old: { action: 'hide', at: at - 8 * DAY },
        [`${'z'.repeat(65)}`]: { action: 'hide', at },
        bad: 5,
      },
    },
    at,
  );
  assert.equal(Object.keys(v.done).length, 200);
  assert.equal(v.done.x, undefined);
  assert.equal(v.done.old, undefined);
});

test('the default storage reads the real clock', async () => {
  const storage = S.memoryStorage();
  const store = S.createSuggestions({ storage });
  const s = await store.add(one());
  assert.ok(Math.abs(s.createdAt - Date.now()) < 5000);
  assert.match(s.id, /^[0-9a-f-]{36}$/);
});
