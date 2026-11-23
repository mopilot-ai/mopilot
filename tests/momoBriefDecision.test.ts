// The morning brief's two decisions (A7, electron/momo/briefDecision.cjs, design 7.2): whether it goes out (on, allowed, not paused, never in quiet hours, never twice a day, only for a user active in the last 7 days) and what it holds (at most one attention item with its source and at most two of yesterday's suggestions; nothing that clears the bar is no brief), and the daily rule at the end of quiet hours.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../electron/momo/briefDecision.cjs');

const DAY = 86_400_000;
const H = 3_600_000;
const NOW = new Date(2026, 10, 16, 7, 30).getTime();
const QUIET = { start: 22 * 60, end: 7 * 60 };
const day = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const base = { now: NOW, enabled: true, allowed: true, paused: false, quietHours: QUIET, lastBriefDay: null, activeDays: [day(NOW - DAY)] };

test('the brief goes out for an active user, on, allowed, awake and outside quiet hours', () => {
  assert.deepEqual(D.decide(base), { fire: true });
});

test('it never goes out when off, not allowed, paused, in quiet hours, already sent today, or away for a week, each with its reason', () => {
  assert.deepEqual(D.decide({ ...base, enabled: false }), { fire: false, reason: 'off' });
  assert.deepEqual(D.decide({ ...base, allowed: false }), { fire: false, reason: 'off' });
  assert.deepEqual(D.decide({ ...base, paused: true }), { fire: false, reason: 'paused' });
  assert.deepEqual(D.decide({ ...base, now: new Date(2026, 10, 16, 6, 59).getTime() }), { fire: false, reason: 'quiet-hours' });
  assert.deepEqual(D.decide({ ...base, now: new Date(2026, 10, 16, 23, 0).getTime() }), { fire: false, reason: 'quiet-hours' });
  assert.deepEqual(D.decide({ ...base, lastBriefDay: day(NOW) }), { fire: false, reason: 'already-today' });
  assert.deepEqual(D.decide({ ...base, lastBriefDay: day(NOW - DAY) }), { fire: true });
  assert.deepEqual(D.decide({ ...base, activeDays: [day(NOW - 7 * DAY)] }), { fire: false, reason: 'away' });
  assert.deepEqual(D.decide({ ...base, activeDays: [] }), { fire: false, reason: 'away' });
});

test('active within the last 7 days (today included) keeps it going; the 7th day back does not; no quiet hours never holds it', () => {
  assert.equal(D.awayOk([day(NOW - 6 * DAY)], NOW), true);
  assert.equal(D.awayOk([day(NOW - 7 * DAY)], NOW), false);
  assert.equal(D.decide({ ...base, quietHours: null, now: new Date(2026, 10, 16, 3, 0).getTime() }).fire, true);
  assert.equal(D.AWAY_TEXT, 'Paused because you were away for a week.');
});

test('the rule is daily at the end of quiet hours, 8:00 without quiet hours', () => {
  assert.equal(D.briefRule(QUIET), 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0;BYSECOND=0');
  assert.equal(D.briefRule({ start: 23 * 60, end: 6 * 60 + 45 }), 'FREQ=DAILY;BYHOUR=6;BYMINUTE=45;BYSECOND=0');
  assert.equal(D.briefRule(null), 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0');
});

const loop = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  text: `Promise ${id}`,
  quote: 'I will do it',
  state: 'open',
  saidAt: NOW - 2 * DAY,
  dueAt: NOW + DAY,
  ...over,
});
const sug = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Suggestion ${id}`,
  source: `Mail: ${id}`,
  status: 'new',
  createdAt: NOW - 20 * H,
  score: { total: 0.4 },
  ...over,
});

test('the one attention item is the most urgent: a card waiting beats a loop due in a day, which beats a failed run', () => {
  const needs = [
    { kind: 'run', id: 'run:r1', title: 'Weekly cleanup', source: 'A routine that did not finish' },
    { kind: 'card', id: 'card:1', title: 'Send the mail', source: 'Mail' },
  ];
  const all = D.pick({ now: NOW, loops: [loop('L1')], needs, suggestions: [] });
  assert.deepEqual([all.attention.kind, all.attention.id, all.attention.source], ['card', 'card:1', 'Mail']);
  const noCard = D.pick({ now: NOW, loops: [loop('L1')], needs: [needs[0]], suggestions: [] });
  assert.deepEqual([noCard.attention.kind, noCard.attention.id], ['loop', 'L1']);
  assert.equal(noCard.attention.source, `Your promise, ${day(NOW - 2 * DAY)}`);
  assert.equal(noCard.attention.quote, 'I will do it');
  const onlyRun = D.pick({ now: NOW, loops: [], needs: [needs[0]], suggestions: [] });
  assert.deepEqual([onlyRun.attention.kind, onlyRun.attention.title], ['run', 'Weekly cleanup']);
});

test('only open loops due within 3 days count: not later, not undated, not snoozed, not closed; a past due one does; one quote at most and it is short', () => {
  const pick = (loops: any[]) => D.pick({ now: NOW, loops, needs: [], suggestions: [] }).attention;
  assert.equal(pick([loop('a', { dueAt: NOW + 4 * DAY })]), null);
  assert.equal(pick([loop('b', { dueAt: undefined })]), null);
  assert.equal(pick([loop('c', { snoozedUntil: NOW + H })]), null);
  assert.equal(pick([loop('d', { state: 'done' })]), null);
  assert.equal(pick([loop('e', { dueAt: NOW - DAY })]).id, 'e');
  assert.equal(pick([loop('f', { snoozedUntil: NOW - H })]).id, 'f');
  // the soonest wins
  assert.equal(pick([loop('g', { dueAt: NOW + 2 * DAY }), loop('h', { dueAt: NOW + 2 * H })]).id, 'h');
  const long = pick([loop('i', { quote: `${'word '.repeat(60)}`, text: 'x'.repeat(300) })]);
  assert.ok(long.quote.length <= 120 && long.quote.endsWith('…'));
  assert.equal(long.title.length, 120);
  assert.equal(pick([loop('j', { quote: undefined })]).quote, null);
});

test('at most two suggestions, yesterday’s that wait for the user, the best first, each with its source; today’s and acted ones are not', () => {
  const dayStart = new Date(NOW).setHours(0, 0, 0, 0);
  const list = [
    sug('a', { score: { total: 0.2 } }),
    sug('b', { score: { total: 0.9 } }),
    sug('c', { score: { total: 0.5 } }),
    sug('today', { createdAt: dayStart + H, score: { total: 1 } }),
    sug('added', { status: 'added', score: { total: 1 } }),
    sug('weak', { score: { total: 0.05 } }),
  ];
  const r = D.pick({ now: NOW, loops: [], needs: [], suggestions: list });
  assert.deepEqual(r.suggestions, [
    { id: 'b', title: 'Suggestion b', source: 'Mail: b' },
    { id: 'c', title: 'Suggestion c', source: 'Mail: c' },
  ]);
  assert.equal(r.attention, null);
  // equal scores keep a stable order by id
  const tie = D.pick({ now: NOW, loops: [], needs: [], suggestions: [sug('z'), sug('m')] });
  assert.deepEqual(
    tie.suggestions.map((s: any) => s.id),
    ['m', 'z'],
  );
});

test('three items at most, and nothing that clears the bar is nothing', () => {
  const r = D.pick({
    now: NOW,
    loops: [loop('L1')],
    needs: [{ kind: 'card', id: 'card:1', title: 'T', source: 'S' }],
    suggestions: [sug('a'), sug('b'), sug('c')],
  });
  assert.equal(1 + r.suggestions.length <= 3, true);
  assert.equal(r.suggestions.length, D.MAX_SUGGESTIONS);
  assert.deepEqual(D.pick({ now: NOW, loops: [], needs: [], suggestions: [] }), { attention: null, suggestions: [] });
});
