// The Tasks panel's four tabs (electron/momo/tasksPanel.cjs): Active holds cards, loops due soon, runs going, runs that did not finish in the last day and finished runs Ready for review until the user marks them; Up next the loops not due soon; Scheduled the approved routines with their next run, paused ones last; Resolved the loops the user closed and the runs the user marked done or archived. Ids are the sources' own, a deleted run is in no tab, nothing is derived into a mark, and a tab is bounded.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  deriveTaskPanel,
  DUE_SOON_MS,
  FAILED_SHOWN_MS,
  REVIEW_SHOWN_MS,
  RESOLVED_SHOWN_MS,
  MAX_PER_TAB,
} = require('../electron/momo/tasksPanel.cjs');
const { RUN_SHOWN_MS } = require('../electron/momo/tasks.cjs');

const NOW = Date.UTC(2026, 10, 15, 20);
const H = 3_600_000;
const D = 24 * H;
const loop = (id: string, over: any = {}) => ({ id, text: `Loop ${id}`, quote: `said ${id}`, state: 'open', saidAt: NOW - D, ...over });
const run = (chatId: string, over: any = {}) => ({ chatId, taskId: 'r1', startedAt: NOW - 3 * H, ...over });
const ended = (chatId: string, outcome: string | undefined, endedAgo: number, over: any = {}) =>
  run(chatId, { startedAt: NOW - endedAgo - H, endedAt: NOW - endedAgo, ...(outcome ? { outcome } : {}), ...over });
const routine = (id: string, over: any = {}) => ({ id, name: `Routine ${id}`, status: 'ACTIVE', rrule: `RULE-${id}`, ...over });
function derive(o: any = {}) {
  return deriveTaskPanel({
    runs: [],
    routineName: (id: string) => (id === 'r1' ? 'Daily brief' : null),
    routines: [],
    nextRun: (rule: string, after: number) => (rule === 'NEVER' ? null : new Date(after + 2 * H)),
    loops: [],
    cards: [],
    marks: {},
    now: NOW,
    ...o,
  });
}
const tab = (tasks: any[], id: string) => tasks.filter((t) => t.tab === id);
const ids = (tasks: any[]) => tasks.map((t) => t.id);

test('Active: a card, the loops due within a day (or past, or by day alone), then runs going, not finished and ready for review', () => {
  const tasks = derive({
    cards: [{ id: 7, params: { momo: { summary: 'Send the mail', source: 'Mail' } } }, { id: 8 }],
    loops: [
      loop('soon', { dueAt: NOW + DUE_SOON_MS }),
      loop('past', { dueAt: NOW - H }),
      loop('later', { dueAt: NOW + DUE_SOON_MS + 1 }),
      loop('dayOnly', { dueDay: '2026-11-16' }),
      loop('dayLater', { dueDay: '2026-11-17' }),
      loop('undated'),
    ],
    runs: [
      run('going', { startedAt: NOW - H }),
      ended('stopped', 'stopped', 2 * H),
      ended('failed', 'failed', 3 * H),
      ended('cut', 'interrupted', 4 * H),
      ended('noWord', undefined, 5 * H),
      ended('ok', 'completed', 6 * H),
    ],
  });
  assert.deepEqual(ids(tab(tasks, 'active')), [
    'card:7',
    'card:8',
    'loop:past',
    'loop:soon',
    'loop:dayOnly',
    'run:going',
    'run:stopped',
    'run:failed',
    'run:cut',
    'run:noWord',
    'run:ok',
  ]);
  const by = (id: string) => tasks.find((t) => t.id === id);
  assert.deepEqual(
    [by('card:7').title, by('card:7').detail, by('card:8').title, by('card:8').detail],
    ['Send the mail', 'Mail', 'MoMo needs your OK', null],
  );
  assert.deepEqual(
    ['card:7', 'loop:soon', 'run:going', 'run:stopped', 'run:ok'].map((id) => by(id).state),
    ['needs-you', 'needs-you', 'running', 'failed', 'review'],
  );
  assert.deepEqual(
    [by('run:going').title, by('run:stopped').outcome, by('run:stopped').at, by('run:ok').outcome],
    ['Daily brief', 'stopped', NOW - 2 * H, 'completed'],
  );
  assert.deepEqual([by('loop:soon').dueDay, by('loop:soon').detail, by('loop:past').at], ['2026-11-16', 'said soon', NOW - D]);
  // up next: later, later by day, undated
  assert.deepEqual(ids(tab(tasks, 'next')), ['loop:later', 'loop:dayLater', 'loop:undated']);
  assert.equal(tab(tasks, 'next')[0].state, 'queued');
});

test('a run that did not finish is shown a day, one waiting for review a week, one going two hours: then they leave unmarked', () => {
  const tasks = derive({
    runs: [
      ended('fresh', 'failed', FAILED_SHOWN_MS - 1),
      ended('stale', 'failed', FAILED_SHOWN_MS),
      ended('wait', 'completed', REVIEW_SHOWN_MS - 1),
      ended('gone', 'completed', REVIEW_SHOWN_MS),
      run('open', { startedAt: NOW - RUN_SHOWN_MS + 1 }),
      run('hung', { startedAt: NOW - RUN_SHOWN_MS }),
    ],
  });
  assert.deepEqual(ids(tasks), ['run:open', 'run:fresh', 'run:wait']);
});

test('the user’s marks move a run: done and archived to Resolved (30 days), deleted out of every tab, a mark on a run still going nowhere', () => {
  const at = (ago: number, mark: string) => ({ mark, at: NOW - ago });
  const tasks = derive({
    runs: [
      ended('d', 'completed', 5 * H),
      ended('a', 'failed', 4 * H),
      ended('x', 'completed', 3 * H),
      ended('old', 'completed', 2 * H),
      run('live', { startedAt: NOW - H }),
    ],
    marks: {
      'run:d': at(H, 'done'),
      'run:a': at(2 * H, 'archived'),
      'run:x': at(H, 'deleted'),
      'run:old': at(RESOLVED_SHOWN_MS, 'done'),
      'run:live': at(H, 'done'),
    },
  });
  assert.deepEqual(ids(tab(tasks, 'resolved')), ['run:d', 'run:a']);
  assert.deepEqual(
    tab(tasks, 'resolved').map((t) => [t.state, t.at]),
    [
      ['done', NOW - H],
      ['archived', NOW - 2 * H],
    ],
  );
  assert.deepEqual(ids(tab(tasks, 'active')), ['run:live']);
  assert.equal(tasks.length, 3);
});

test('Resolved: closed loops (done or dismissed, newest first, 30 days, falling back to when it was said) and marked runs together', () => {
  const tasks = derive({
    loops: [
      loop('done', { state: 'done', closedAt: NOW - 2 * H }),
      loop('dismissed', { state: 'dismissed', closedAt: NOW - H }),
      loop('noClose', { state: 'done', saidAt: NOW - 3 * H }),
      loop('stale', { state: 'done', closedAt: NOW - RESOLVED_SHOWN_MS }),
      loop('staleSaid', { state: 'dismissed', saidAt: NOW - RESOLVED_SHOWN_MS - 1 }),
    ],
    runs: [ended('m', 'completed', 4 * H)],
    marks: { 'run:m': { mark: 'done', at: NOW - 30 * 60_000 } },
  });
  assert.deepEqual(ids(tab(tasks, 'resolved')), ['run:m', 'loop:dismissed', 'loop:done', 'loop:noClose']);
  assert.deepEqual(
    tab(tasks, 'resolved').map((t) => t.state),
    ['done', 'dismissed', 'done', 'done'],
  );
  assert.equal(tab(tasks, 'resolved')[3].at, NOW - 3 * H);
});

test('a snoozed loop is out until it wakes; an equal time breaks by id', () => {
  const tasks = derive({
    loops: [
      loop('sleep', { snoozedUntil: NOW + H }),
      loop('woke', { snoozedUntil: NOW - H }),
      loop('b', { saidAt: NOW - 5 }),
      loop('a', { saidAt: NOW - 5 }),
    ],
  });
  assert.deepEqual(ids(tab(tasks, 'next')), ['loop:a', 'loop:b', 'loop:woke']);
  const closed = derive({ loops: [loop('x', { state: 'done', closedAt: NOW - H }), loop('a', { state: 'done', closedAt: NOW - H })] });
  assert.deepEqual(ids(closed), ['loop:a', 'loop:x']);
});

test('Scheduled: each approved routine with its next run, the paused ones after with none, by name when equal', () => {
  const tasks = derive({
    routines: [
      routine('b', { name: 'Zeta' }),
      routine('p', { status: 'PAUSED', name: 'Paused one' }),
      routine('never', { rrule: 'NEVER', name: 'Alpha' }),
      routine('a', { name: '   ' }),
    ],
  });
  assert.deepEqual(ids(tab(tasks, 'scheduled')), ['routine:a', 'routine:b', 'routine:never', 'routine:p']);
  const [a, b, never, p] = tab(tasks, 'scheduled');
  assert.deepEqual([a.title, a.nextAt, a.paused, a.state, a.kind, a.ref], ['A routine', NOW + 2 * H, false, 'scheduled', 'routine', 'a']);
  assert.deepEqual([b.title, never.nextAt, p.paused, p.nextAt], ['Zeta', null, true, null]);
});

test('a tab is bounded by itself, so a long one cannot hide another', () => {
  const tasks = derive({ loops: Array.from({ length: MAX_PER_TAB + 20 }, (_, i) => loop(`L${i}`)), routines: [routine('r')] });
  assert.equal(tab(tasks, 'next').length, MAX_PER_TAB);
  assert.equal(tab(tasks, 'scheduled').length, 1);
});

test('deriving changes none of its sources and a task’s id is its source’s own', () => {
  const o = {
    loops: [loop('L1')],
    runs: [ended('c', 'completed', H)],
    marks: { 'run:c': { mark: 'done', at: NOW - 1 } },
    cards: [{ id: 'k' }],
  };
  const before = JSON.stringify(o);
  const first = derive(o);
  assert.equal(JSON.stringify(o), before);
  assert.deepEqual(first, derive(JSON.parse(before)));
  assert.deepEqual(ids(first).sort(), ['card:k', 'loop:L1', 'run:c']);
});

test('what a source leaves out falls back: a card named by its tool, loops with no words of their own, runs that started together', () => {
  const tasks = derive({
    cards: [{ id: 'tool', params: { momo: { tool: 'send_mail' } } }],
    loops: [
      loop('a', { quote: undefined, dueAt: NOW + H }),
      loop('b', { quote: undefined }),
      loop('c', { state: 'done', quote: undefined, closedAt: NOW - H }),
    ],
    runs: [run('r2', { startedAt: NOW - H }), run('r1', { startedAt: NOW - H })],
  });
  assert.deepEqual(ids(tasks), ['card:tool', 'loop:a', 'run:r1', 'run:r2', 'loop:b', 'loop:c']);
  assert.deepEqual(
    [tasks[0].title, tasks[0].detail, tasks[1].detail, tasks[4].detail, tasks[5].detail],
    ['send_mail', null, null, null, null],
  );
});
