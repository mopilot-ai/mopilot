// MoMo's notice records on a Host (host/src/momoNoticeStore.mjs): the atomic daily count and brief claim, the decision log and what could not be sorted, the domains the user writes to, the cards shown, and what a corrupt record reads as.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createNoticeStore, KEEP_DECISIONS, noticeShape } from '../host/src/momoNoticeStore.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';

function store(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-notice-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { at: 1_700_000_000_000 };
  const make = () =>
    createNoticeStore({ home: { storage: { dir }, data: { safeStorage: createFileSafeStorage(dir) } }, now: () => clock.at });
  return { dir, clock, make, s: make() };
}
const matter = (key: string) => ({ matterKey: key, state: 'open', title: key, summary: 's', sources: [], updatedAt: 'x' });
const decision = (id: string, over: object = {}) => ({
  changeId: id,
  decision: 'quiet',
  outcome: 'quiet',
  reason: 'r',
  title: id,
  decidedBy: 'rule:x',
  at: 'x',
  ...over,
});

test('matters are kept and listed across a reopen', async (t) => {
  const { s, make } = store(t);
  assert.equal(await s.notice.getMatter('a'), undefined);
  await s.notice.putMatter(matter('a'));
  await s.notice.putMatter(matter('b'));
  assert.deepEqual(
    (await make().notice.listMatters()).map((m: any) => m.matterKey),
    ['a', 'b'],
  );
  assert.equal((await make().notice.getMatter('a'))?.title, 'a');
});

test('the day count is atomic and idempotent per key, resets with the day, and a keyless count is counted each time', async (t) => {
  const { s } = store(t);
  const count = (day: string, cap: number, key?: string) => s.notice.tryCountTold(day, cap, key);
  assert.deepEqual(
    [await count('d1', 2, 'a'), await count('d1', 2, 'a'), await count('d1', 2, 'b'), await count('d1', 2, 'c')],
    [true, true, true, false],
  );
  // the same key is still counted after the cap: it was told already
  assert.equal(await count('d1', 2, 'b'), true);
  assert.equal(await count('d2', 1, 'c'), true);
  assert.deepEqual([await count('d2', 1), await count('d2', 5)], [false, true]);
  const racing = await Promise.all(Array.from({ length: 5 }, (_, i) => count('d3', 3, `k${i}`)));
  assert.equal(racing.filter(Boolean).length, 3);
});

test('a brief is claimed once a day, released for another try, and old claims are forgotten', async (t) => {
  const { s } = store(t);
  assert.deepEqual([await s.notice.claimBrief('2026-11-24'), await s.notice.claimBrief('2026-11-24')], [true, false]);
  await s.notice.releaseBrief('2026-11-24');
  assert.equal(await s.notice.claimBrief('2026-11-24'), true);
  for (let i = 1; i <= 35; i++) await s.notice.claimBrief(`2026-12-${String(i).padStart(2, '0')}`);
  assert.equal(await s.notice.claimBrief('2026-11-24'), true, 'the oldest claim was pruned');
});

test('the cursors: last pass and last brief read as none until set, the connect day is set once', async (t) => {
  const { s, make } = store(t);
  assert.deepEqual([s.lastRunAt(), s.lastBriefAt()], [undefined, undefined]);
  await s.setLastRunAt(5);
  await s.setLastBriefAt(7);
  assert.equal(await s.connectDay('2026-11-24'), '2026-11-24');
  assert.equal(await s.connectDay('2026-12-01'), '2026-11-24');
  const again = make();
  assert.deepEqual([again.lastRunAt(), again.lastBriefAt()], [5, 7]);
});

test('the decision log is capped; what could not be sorted waits until a pass sorts it', async (t) => {
  const { s } = store(t);
  await s.addDecision(decision('gmail:u', { outcome: 'unsorted', decision: 'unsorted', reason: 'Not JSON.', title: 'Odd' }));
  assert.deepEqual(s.unsorted(), [{ key: 'gmail:u', title: 'Odd', error: 'Not JSON.' }]);
  await s.addDecision(decision('gmail:u'));
  assert.deepEqual(s.unsorted(), []);
  for (let i = 0; i < 60; i++) await s.addDecision(decision(`gmail:x${i}`, { outcome: 'unsorted', decision: 'unsorted' }));
  assert.equal(s.unsorted().length, 50);
  for (let i = 0; i < KEEP_DECISIONS; i++) await s.addDecision(decision(`gmail:y${i}`));
  assert.equal(s.decisions().length, KEEP_DECISIONS);
  assert.equal(s.decisions().at(-1).changeId, `gmail:y${KEEP_DECISIONS - 1}`);
});

test('the domains the user writes to are kept once each and capped', async (t) => {
  const { s } = store(t);
  await s.learnDomains(['acme.com', 'acme.com', 'bank.test']);
  assert.deepEqual(s.knownDomains(), ['acme.com', 'bank.test']);
  await s.learnDomains(Array.from({ length: 510 }, (_, i) => `d${i}.test`));
  assert.equal(s.knownDomains().length, 500);
  assert.equal(s.knownDomains().at(-1), 'd509.test');
});

test('cards shown keep the newest sixty', async (t) => {
  const { s } = store(t);
  for (let i = 0; i < 65; i++) await s.saveView(`brief:${i}`, { n: i }, i);
  const keys = s.views().map((v: any) => v.key);
  assert.equal(keys.length, 60);
  assert.ok(keys.includes('brief:64') && !keys.includes('brief:0'));
  assert.deepEqual(
    s.views().find((v: any) => v.key === 'brief:64'),
    { key: 'brief:64', view: { n: 64 }, at: 64 },
  );
});

test('a record that is not the right shape reads as an empty one', () => {
  assert.deepEqual(noticeShape(null), {
    matters: {},
    told: { day: '', keys: [] },
    claims: {},
    decisions: [],
    views: {},
    domains: [],
    unsorted: {},
    lastRunAt: 0,
    lastBriefAt: 0,
    connectDay: '',
    reactions: [],
    storeId: '',
    reactionSeq: 0,
    hiddenOffers: [],
    reads: { day: '', count: 0 },
    backoff: { until: 0, tries: 0 },
  });
  const junk = noticeShape({
    matters: [],
    told: { day: 3, keys: ['a', 4] },
    claims: 'x',
    decisions: [null, { changeId: 5 }, { changeId: 'ok' }],
    domains: ['a', 1],
    lastRunAt: 'x',
    connectDay: 4,
  });
  assert.deepEqual(
    [junk.matters, junk.told, junk.claims, junk.decisions, junk.domains, junk.lastRunAt, junk.connectDay],
    [{}, { day: '', keys: ['a'] }, {}, [{ changeId: 'ok' }], ['a'], 0, ''],
  );
});

test('reading turns are counted against a daily budget that resets with the day, and the backoff survives a reopen', async (t) => {
  const { s, make } = store(t);
  assert.deepEqual([await s.countRead('d1', 2), await s.countRead('d1', 2), await s.countRead('d1', 2)], [true, true, false]);
  assert.equal(await s.countRead('d2', 2), true);
  // giving reads back on a day with no count yet starts that day empty
  assert.equal(await s.allowMore('d3', 50), true);
  assert.deepEqual([await s.countRead('d3', 1), await s.countRead('d3', 1)], [true, false]);
  assert.equal(await s.allowMore('d3', 50), true);
  assert.equal(await s.countRead('d3', 1), true);
  assert.deepEqual(s.backoff(), { until: 0, tries: 0 });
  await s.setBackoff({ until: 99, tries: 2 });
  assert.deepEqual(make().backoff(), { until: 99, tries: 2 });
  const junk = noticeShape({ reads: { day: 5, count: -1 }, backoff: { until: 'x', tries: 1.5 } });
  assert.deepEqual(
    [junk.reads, junk.backoff],
    [
      { day: '', count: 0 },
      { until: 0, tries: 0 },
    ],
  );
});

test('reactions and hidden offers are kept once, capped, and read back', async (t) => {
  const { s, make } = store(t);
  await s.addReaction({ kind: 'not_needed', rowId: 'a' });
  await s.hideOffer('o1');
  await s.hideOffer('o1');
  assert.deepEqual([make().reactions().length, make().hiddenOffers()], [1, ['o1']]);
  for (let i = 0; i < 510; i++) await s.addReaction({ kind: 'signal_make', rowId: `r${i}` });
  assert.equal(s.reactions().length, 500);
  // every reaction carries the store's id and the next number, which only grows, even as the oldest are trimmed
  const all = s.reactions();
  assert.equal(new Set(all.map((r: any) => r.store)).size, 1);
  assert.deepEqual([all[0].seq, all.at(-1).seq], [12, 511]);
  assert.deepEqual(
    [noticeShape({ storeId: 5, reactionSeq: -1 }).storeId, noticeShape({ storeId: 5, reactionSeq: -1 }).reactionSeq],
    ['', 0],
  );
  for (let i = 0; i < 510; i++) await s.hideOffer(`h${i}`);
  assert.equal(s.hiddenOffers().length, 500);
  const junk = noticeShape({ reactions: [null, { kind: 1, rowId: 'x' }, { kind: 'k', rowId: 'x' }], hiddenOffers: ['a', 5] });
  assert.deepEqual([junk.reactions.length, junk.hiddenOffers], [1, ['a']]);
});
