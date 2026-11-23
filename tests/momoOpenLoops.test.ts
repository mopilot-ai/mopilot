// MoMo's open-loop store (#2139 P4, electron/momo/openLoops.cjs): sealed on disk, a pass's loops added once (the same quote or text from that chat renews instead), never reopened after the user closed them, at most MAX_OPEN open with the oldest `likely` ones dropped first and a `sure` one never dropped to make room, closed ones pruned after 90 days; the user's done, dismiss, reopen and snooze; nudges recorded; Reset erases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe, scratch } from './support/momo-memory.ts';

const require = createRequire(import.meta.url);
const {
  OpenLoopStore,
  LoopError,
  FILE,
  MAX_OPEN,
  CLOSED_KEEP_MS,
  NUDGES_KEPT,
  shapeOf,
  makeRoom,
} = require('../electron/momo/openLoops.cjs');

const SRC = { chatId: 'momo-main', harness: 'claude' };
function store(o: { safe?: any } = {}) {
  const dir = path.join(scratch(), 'momo');
  let clock = 1_000_000;
  let n = 0;
  const s = new OpenLoopStore({ dir, safeStorage: o.safe ?? fakeSafe(), now: () => clock, newId: () => `L${++n}` });
  let changes = 0;
  s.on('changed', () => changes++);
  return { s, dir, tick: (ms: number) => (clock += ms), now: () => clock, changes: () => changes };
}
const add = (text: string, quote = text, extra: any = {}) => ({
  kind: 'todo',
  text,
  quote,
  line: { text: quote, at: 500, turnId: 't1' },
  tz: 'Europe/Lisbon',
  confidence: 'sure',
  ...extra,
});
const ops = (o: any) => ({ add: [], mention: [], done: [], ...o });

test('a pass’s loops are added sealed; the same quote or text from that chat renews it instead', async () => {
  const t = store();
  assert.deepEqual(t.s.list(), [], 'no file yet: none');
  const r = await t.s.applyPass(
    ops({ add: [add('Renew the lease', 'renew the lease', { dueAt: 9_000_000, dueDay: '2030-03-06', event: 'Lease' })] }),
    SRC,
  );
  assert.deepEqual(r, { added: 1, renewed: 0, closed: 0, refused: 0 });
  const [l] = t.s.list();
  assert.deepEqual(l, {
    id: 'L1',
    kind: 'todo',
    text: 'Renew the lease',
    quote: 'renew the lease',
    source: { chatId: 'momo-main', harness: 'claude', turnId: 't1' },
    saidAt: 500,
    tz: 'Europe/Lisbon',
    confidence: 'sure',
    dueAt: 9_000_000,
    dueDay: '2030-03-06',
    event: 'Lease',
    lastMentionedAt: 1_000_000,
    state: 'open',
    nudged: [],
  });
  const raw = fs.readFileSync(path.join(t.dir, FILE), 'utf8');
  assert.equal(raw.includes('lease'), false, 'never plain text on disk');
  t.tick(10);
  const again = await t.s.applyPass(ops({ add: [add('RENEW the lease!', 'other words'), add('x', 'Renew  the lease')] }), SRC);
  assert.deepEqual(again, { added: 0, renewed: 2, closed: 0, refused: 0 });
  assert.equal(t.s.list()[0].lastMentionedAt, 1_000_010);
  // the same words from another chat are another loop
  await t.s.applyPass(ops({ add: [add('Renew the lease')] }), { chatId: 'momo-2', harness: 'codex' });
  assert.equal(t.s.open().length, 2);
  assert.ok(t.changes() >= 3);
});

test('mention renews, done closes; a loop the user closed is never reopened by a pass', async () => {
  const t = store();
  await t.s.applyPass(ops({ add: [add('Call mum'), add('Book flights')] }), SRC);
  t.tick(5);
  assert.deepEqual(await t.s.applyPass(ops({ mention: ['L1', 'nope'], done: ['L2', 'nope'] }), SRC), {
    added: 0,
    renewed: 1,
    closed: 1,
    refused: 0,
  });
  const byId = Object.fromEntries(t.s.list().map((l: any) => [l.id, l]));
  assert.equal(byId.L1.lastMentionedAt, 1_000_005);
  assert.equal(byId.L2.state, 'done');
  await t.s.setState('L1', 'dismissed');
  assert.deepEqual(await t.s.applyPass(ops({ add: [add('Call mum')], mention: ['L1'], done: ['L1'] }), SRC), {
    added: 0,
    renewed: 0,
    closed: 0,
    refused: 0,
  });
  assert.equal(t.s.list().find((l: any) => l.id === 'L1').state, 'dismissed');
});

test('the user closes, dismisses, reopens and snoozes a loop; nudges are recorded, the last NUDGES_KEPT kept', async () => {
  const t = store();
  await t.s.applyPass(ops({ add: [add('Call mum')] }), SRC);
  assert.equal((await t.s.setState('L1', 'done')).closedAt, 1_000_000);
  t.tick(7);
  const back = await t.s.setState('L1', 'open');
  assert.equal(back.closedAt, undefined);
  assert.equal(back.lastMentionedAt, 1_000_007);
  await assert.rejects(t.s.setState('L1', 'gone'), (e: any) => e instanceof LoopError && e.code === 'bad_args');
  await assert.rejects(t.s.setState('nope', 'done'), (e: any) => e.code === 'not_found');
  assert.equal((await t.s.snooze('L1', t.now() + 1000)).snoozedUntil, 1_001_007);
  assert.equal((await t.s.snooze('L1', null)).snoozedUntil, undefined);
  await t.s.snooze('L1', t.now() + 1000);
  assert.equal((await t.s.snooze('L1', t.now() - 1)).snoozedUntil, undefined, 'a time past wakes it');
  await assert.rejects(t.s.snooze('L1', Number.NaN), (e: any) => e.code === 'bad_args');
  for (let i = 0; i < NUDGES_KEPT + 2; i++) await t.s.nudged('L1', { at: i, trigger: 'stale', key: `stale:${i}` });
  const last = await t.s.nudged('L1', { at: 99, trigger: 'due', key: 'due:L1', askedClose: true });
  assert.equal(last.nudged.length, NUDGES_KEPT);
  assert.equal(last.nudged.at(-1).key, 'due:L1');
  assert.equal(last.askedClose, 99);
});

test('at MAX_OPEN the oldest likely loop goes first; a sure loop is never dropped to make room', () => {
  const loop = (id: string, confidence: string, saidAt: number, state = 'open') => ({ id, confidence, saidAt, state });
  const full = (likely: number) => Array.from({ length: MAX_OPEN }, (_, i) => loop(`L${i}`, i < likely ? 'likely' : 'sure', 1000 - i));
  const some = full(3);
  some.push(loop('closed', 'likely', 0, 'done'));
  assert.equal(makeRoom(some), true);
  assert.equal(
    some.some((l: any) => l.id === 'L2'),
    false,
    'the oldest likely one (said first) went',
  );
  assert.ok(
    some.some((l: any) => l.id === 'closed'),
    'a closed loop is not what makes room',
  );
  const allSure = full(0);
  assert.equal(makeRoom(allSure), false);
  assert.equal(allSure.length, MAX_OPEN, 'no sure loop dropped');
  assert.equal(makeRoom([loop('a', 'sure', 1)]), true);
});

test('a pass past the cap with only sure loops open is refused and counted, not dropped silently', async () => {
  const t = store();
  await t.s.applyPass(ops({ add: Array.from({ length: MAX_OPEN }, (_, i) => add(`Loop ${i}`)) }), SRC);
  const r = await t.s.applyPass(ops({ add: [add('One more')] }), SRC);
  assert.deepEqual(r, { added: 0, renewed: 0, closed: 0, refused: 1 });
  assert.equal(t.s.open().length, MAX_OPEN);
});

test('closed loops are pruned after CLOSED_KEEP_MS; what isn’t a loop is left out; Reset erases and drops queued changes', async () => {
  const t = store();
  await t.s.applyPass(ops({ add: [add('Old'), add('New')] }), SRC);
  await t.s.setState('L1', 'done');
  t.tick(CLOSED_KEEP_MS + 1);
  await t.s.setState('L2', 'done');
  assert.deepEqual(
    t.s.list().map((l: any) => l.id),
    ['L2'],
  );
  assert.deepEqual(shapeOf(null, 0), { loops: [] });
  assert.deepEqual(shapeOf({ loops: [{ id: 'x' }] }, 0), { loops: [] });
  // a closed loop with no time it was closed reads as closed long ago
  const closed = { ...t.s.list()[0], state: 'done', closedAt: undefined };
  assert.deepEqual(shapeOf({ loops: [closed] }, CLOSED_KEEP_MS + 1), { loops: [] });
  const dropped = assert.rejects(t.s.applyPass(ops({ add: [add('Late')] }), SRC), (e: any) => e.code === 'erased');
  await t.s.erase();
  await dropped;
  await t.s.idle();
  assert.equal(fs.existsSync(path.join(t.dir, FILE)), false);
  assert.deepEqual(t.s.list(), []);
});

test('without encryption nothing is read', () => {
  const safe = fakeSafe();
  safe.available = false;
  const t = store({ safe });
  assert.throws(
    () => t.s.list(),
    (e: any) => e.code === 'unavailable',
  );
});
