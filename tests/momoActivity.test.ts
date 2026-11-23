// MoMo's activity list (electron/momo/activity.cjs): routine runs and errands (turns of MoMo's chats that used the browser or computer), each with its steps; a run going running → needs-you → done told to phones once per change; the bounds (50 items, 7 days, 20 steps, clipped titles and steps); a history that can't be read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createMomoActivity,
  isControlCall,
  liveOf,
  MAX_ITEMS,
  KEEP_MS,
  MAX_STEPS,
  MAX_TITLE,
  MAX_STEP,
  MAX_ERRAND_CHATS,
  CHANGE_MS,
  CACHE_MS,
} = require('../electron/momo/activity.cjs');
const { stepOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');
const { stateOfCall } = require('../electron/capabilities/browser/chromePanelToolLines.cjs');

const NOW = Date.UTC(2030, 0, 15, 12);
const sec = (ms: number) => ms / 1000;
const ask = (text: string) => ({ type: 'userMessage', id: 'u', content: [{ type: 'text', text }] });
const nav = (url: string, status = 'completed') => ({
  type: 'mcpToolCall',
  id: 'n',
  server: 'mopilot_browser',
  tool: 'navigate',
  arguments: { url },
  status,
});
const click = (status = 'completed') => ({ type: 'dynamicToolCall', id: 'k', tool: 'mcp__mopilot_computer__click', status });
const turn = (id: string | undefined, startedMs: number | null, items: any[], status = 'completed') => ({
  id,
  startedAt: startedMs === null ? null : sec(startedMs),
  status,
  items,
});

/** A fake MoMo: its runs, its chats, their histories and session states, with every read and every change told recorded. */
function rig() {
  const s = {
    runs: [] as any[],
    names: new Map<string, string>(),
    chats: [] as { chatId: string; updatedAt: number }[],
    turns: new Map<string, any[] | Error>(),
    states: new Map<string, any>(),
    versions: new Map<string, number>(),
    reads: [] as [string, boolean][],
    told: [] as string[],
    timers: [] as { fn: () => void; ms: number }[],
    now: NOW,
  };
  const activity = createMomoActivity({
    runs: (since: number) => s.runs.filter((r) => r.startedAt >= since),
    routineName: (id: string) => s.names.get(id) ?? null,
    chats: (since: number) => s.chats.filter((c) => c.updatedAt >= since),
    turns: async (chatId: string, running: boolean) => {
      s.reads.push([chatId, running]);
      const t = s.turns.get(chatId) ?? [];
      if (t instanceof Error) throw t;
      return t;
    },
    chatState: (chatId: string) => s.states.get(chatId) ?? null,
    version: (chatId: string) => String(s.versions.get(chatId) ?? 0),
    stepOf,
    stateOfCall,
    changed: (id: string) => s.told.push(id),
    now: () => s.now,
    schedule: (fn: () => void, ms: number) => s.timers.push({ fn, ms }),
  });
  /** The chat moved: its version goes up, as a patch's revision does. */
  const bump = (chatId: string) => s.versions.set(chatId, (s.versions.get(chatId) ?? 0) + 1);
  /** Runs every comparison due, and lets it finish. */
  const fire = async () => {
    for (const t of s.timers.splice(0)) t.fn();
    await new Promise((r) => setImmediate(r));
  };
  return { s, activity, bump, fire };
}

test('a routine run goes running → needs-you → done, each change told to phones once, its steps from its chat', async () => {
  const { s, activity, bump, fire } = rig();
  s.names.set('r1', 'Morning brief');
  s.runs.push({ chatId: 'run1', taskId: 'r1', startedAt: NOW - 60_000 });
  s.states.set('run1', { turn: 'running', approvals: [] });
  s.turns.set('run1', [turn('t1', NOW - 60_000, [ask('go'), nav('https://news.example.com/a', 'inProgress')], 'inProgress')]);
  let { items } = await activity.list();
  assert.deepEqual(items, [
    {
      id: 'routine:run1',
      kind: 'routine',
      title: 'Morning brief',
      state: 'running',
      chatId: 'run1',
      startedAt: NOW - 60_000,
      steps: [{ text: 'Opening news.example.com', state: 'running', at: NOW - 60_000 }],
    },
  ]);
  assert.deepEqual(s.reads, [['run1', true]]);

  // an approval comes up: the chat is compared once, after a moment, however often it moved
  s.states.set('run1', { turn: 'awaitingUser', approvals: [{ id: 'a1' }] });
  bump('run1');
  activity.touched('run1');
  activity.touched('run1');
  assert.equal(s.timers.length, 1);
  assert.equal(s.timers[0].ms, CHANGE_MS);
  await fire();
  assert.deepEqual(s.told, ['routine:run1']);
  assert.equal((await activity.list()).items[0].state, 'needs-you');

  // answered and finished: done, and its last step reads done
  s.states.set('run1', { turn: 'idle', approvals: [] });
  s.runs[0] = { ...s.runs[0], endedAt: NOW, outcome: 'completed' };
  s.turns.set('run1', [turn('t1', NOW - 60_000, [ask('go'), nav('https://news.example.com/a')])]);
  bump('run1');
  activity.touched('run1');
  await fire();
  assert.deepEqual(s.told, ['routine:run1', 'routine:run1']);
  ({ items } = await activity.list());
  assert.equal(items[0].state, 'done');
  assert.deepEqual(items[0].steps, [{ text: 'Opened news.example.com', state: 'done', at: NOW - 60_000 }]);

  // nothing changed: nothing is told, and the history is not read again
  const reads = s.reads.length;
  activity.touched('run1');
  await fire();
  assert.equal(s.told.length, 2);
  assert.equal(s.reads.length, reads);
});

test('a run that ended any other way failed; one whose routine is gone reads "Routine"; an open run on an idle chat runs', async () => {
  const { s, activity } = rig();
  s.runs.push({ chatId: 'a', taskId: 'gone', startedAt: NOW - 3000, endedAt: NOW, outcome: 'stopped' });
  s.runs.push({ chatId: 'b', taskId: 'gone', startedAt: NOW - 2000 });
  s.runs.push({ chatId: 'c', taskId: 'gone', startedAt: NOW - 1000, endedAt: NOW, outcome: 'interrupted' });
  const { items } = await activity.list();
  assert.deepEqual(
    items.map((i: any) => [i.id, i.title, i.state, i.steps.length]),
    [
      ['routine:c', 'Routine', 'failed', 0],
      ['routine:b', 'Routine', 'running', 0],
      ['routine:a', 'Routine', 'failed', 0],
    ],
  );
});

test('errands: each turn of MoMo’s chats that used the browser or computer, titled by what was asked, with that turn’s steps', async () => {
  const { s, activity } = rig();
  s.chats.push({ chatId: 'main', updatedAt: NOW });
  s.states.set('main', { turn: 'running', approvals: [], questions: [{ id: 'q', status: 'pending' }] });
  s.turns.set('main', [
    turn('t0', NOW - 5000, [ask('What is on today?'), { type: 'mcpToolCall', server: 'sage_ab', tool: 'momo_calendar_events' }]),
    turn('t1', NOW - 4000, [ask('Book a table for two'), nav('https://opentable.com/r'), click('failed')]),
    turn(undefined, null, [nav('https://example.org')], 'interrupted'),
    turn('t3', NOW - 1000, [ask('  Pay\n the bill '), click('inProgress')], 'inProgress'),
  ]);
  const { items } = await activity.list();
  assert.deepEqual(
    items.map((i: any) => [i.id, i.kind, i.title, i.state, i.startedAt, i.steps.map((x: any) => `${x.state}:${x.text}`)]),
    [
      // the turn with no start sorts by its chat's last write
      ['errand:main:2', 'errand', 'Errand', 'failed', NOW, ['done:Opened example.org']],
      [`errand:main:t${NOW - 1000}`, 'errand', 'Pay the bill', 'needs-you', NOW - 1000, ['running:Clicking']],
      [
        `errand:main:t${NOW - 4000}`,
        'errand',
        'Book a table for two',
        'done',
        NOW - 4000,
        ['done:Opened opentable.com', 'failed:Click failed'],
      ],
    ],
  );
  assert.deepEqual(s.reads, [['main', true]]);
});

test('an errand whose harness quit under it failed; an idle chat’s last errand is done', async () => {
  const { s, activity } = rig();
  s.chats.push({ chatId: 'x', updatedAt: NOW }, { chatId: 'y', updatedAt: NOW });
  s.states.set('x', { turn: 'crashed' });
  s.turns.set('x', [turn('t', NOW - 10, [nav('https://a.example')])]);
  s.turns.set('y', [turn('t', NOW - 20, [nav('https://b.example')])]);
  const { items } = await activity.list();
  assert.deepEqual(
    items.map((i: any) => [i.id, i.state]),
    [
      [`errand:x:t${NOW - 10}`, 'failed'],
      [`errand:y:t${NOW - 20}`, 'done'],
    ],
  );
  assert.deepEqual(
    s.reads.map((r) => r[1]),
    [false, false],
  );
});

test('bounds: at most 50 items and none older than 7 days, newest first; runs older than the 50th are never read', async () => {
  const { s, activity } = rig();
  for (let i = 0; i < 70; i++) s.runs.push({ chatId: `r${i}`, taskId: 't', startedAt: NOW - i * 60_000 });
  s.runs.push({ chatId: 'old', taskId: 't', startedAt: NOW - KEEP_MS - 1 });
  const { items } = await activity.list();
  assert.equal(items.length, MAX_ITEMS);
  assert.equal(items[0].id, 'routine:r0');
  assert.equal(items.at(-1).id, 'routine:r49');
  assert.ok(items.every((x: any, i: number) => i === 0 || items[i - 1].startedAt >= x.startedAt));
  assert.equal(s.reads.length, MAX_ITEMS);
  // an errand older than 7 days in a chat written to since is left out
  const e = rig();
  e.s.chats.push({ chatId: 'm', updatedAt: NOW });
  e.s.turns.set('m', [turn('old', NOW - KEEP_MS - 5, [nav('https://a.example')]), turn('new', NOW - 5, [nav('https://a.example')])]);
  assert.deepEqual(
    (await e.activity.list()).items.map((i: any) => i.id),
    [`errand:m:t${NOW - 5}`],
  );
});

test('bounds: only the 20 chats written to last are read for errands; steps keep the newest 20; titles and steps are clipped', async () => {
  const { s, activity } = rig();
  for (let i = 0; i < MAX_ERRAND_CHATS + 3; i++) s.chats.push({ chatId: `c${i}`, updatedAt: NOW - i });
  const long = 'Find me a flight '.repeat(20);
  const calls = Array.from({ length: 30 }, (_, i) => ({ type: 'dynamicToolCall', id: `d${i}`, tool: `browser_${'x'.repeat(200)}${i}` }));
  s.turns.set('c0', [turn('t', NOW - 100, [ask(long), ...calls])]);
  await activity.list();
  assert.equal(s.reads.length, MAX_ERRAND_CHATS);
  assert.ok(!s.reads.some(([id]) => id === `c${MAX_ERRAND_CHATS}`));
  const [item] = (await activity.list()).items;
  assert.equal(item.title.length, MAX_TITLE);
  assert.ok(item.title.endsWith('…'));
  assert.equal(item.steps.length, MAX_STEPS);
  assert.ok(item.steps.every((x: any) => x.text.length <= MAX_STEP));
  assert.ok(item.steps.at(-1).text.endsWith('…'));
});

test('a routine run’s chat is never also read as an errand chat; a history that can’t be read lists the run with no steps', async () => {
  const { s, activity } = rig();
  s.runs.push({ chatId: 'run', taskId: 't', startedAt: NOW - 10 });
  s.chats.push({ chatId: 'run', updatedAt: NOW });
  s.turns.set('run', new Error('history gone'));
  const { items } = await activity.list();
  assert.deepEqual(
    items.map((i: any) => [i.id, i.steps]),
    [['routine:run', []]],
  );
  assert.equal(s.reads.length, 1);
});

test('changes: a new errand and one that went are both told; a chat MoMo no longer lists is forgotten', async () => {
  const { s, activity, bump, fire } = rig();
  s.chats.push({ chatId: 'm', updatedAt: NOW });
  s.turns.set('m', []);
  await activity.list();
  // a first errand turn appears
  s.turns.set('m', [turn('t1', NOW - 5, [ask('Check the price'), nav('https://shop.example')])]);
  bump('m');
  activity.touched('m');
  await fire();
  assert.deepEqual(s.told, [`errand:m:t${NOW - 5}`]);
  // the chat leaves the list (deleted): its errand is told gone
  s.chats.length = 0;
  activity.touched('m');
  await fire();
  assert.deepEqual(s.told, [`errand:m:t${NOW - 5}`, `errand:m:t${NOW - 5}`]);
  activity.touched('m');
  await fire();
  assert.equal(s.told.length, 2);
  // a chat no list ever showed, touched for the first time, tells what it has
  s.runs.push({ chatId: 'fresh', taskId: 't', startedAt: NOW });
  activity.touched('fresh');
  await fire();
  assert.deepEqual(s.told.at(-1), 'routine:fresh');
  // nothing to compare for a bad id
  activity.touched('');
  activity.touched(undefined as any);
  assert.equal(s.timers.length, 0);
  // a cached chat that leaves every list is dropped from the cache: listing it again reads it again
  await activity.list();
  s.runs.length = 0;
  await activity.list();
  s.runs.push({ chatId: 'fresh', taskId: 't', startedAt: NOW });
  const before = s.reads.length;
  await activity.list();
  assert.equal(s.reads.length, before + 1);
});

test('a comparison that fails is noted, not thrown', async () => {
  const { activity, fire, s } = rig();
  s.runs = null as any;
  activity.touched('x');
  await fire();
  assert.deepEqual(s.told, []);
});

test('the defaults: the real clock and an unref’d timer', () => {
  const a = createMomoActivity({
    runs: () => [],
    routineName: () => null,
    chats: () => [],
    turns: async () => [],
    chatState: () => null,
    version: () => '',
    stepOf,
    stateOfCall,
    changed: () => undefined,
  });
  a.touched('c');
  return a.list().then((r: any) => assert.deepEqual(r, { items: [] }));
});

test('isControlCall and liveOf', () => {
  assert.equal(isControlCall(nav('https://a')), true);
  assert.equal(isControlCall(click()), true);
  assert.equal(isControlCall({ type: 'mcpToolCall', server: 'claude-in-chrome', tool: 'find' }), true);
  assert.equal(isControlCall({ type: 'mcpToolCall', tool: 'desktop_app_click' }), true);
  assert.equal(isControlCall({ type: 'mcpToolCall', server: 'sage_1', tool: 'momo_memory_search' }), false);
  assert.equal(isControlCall({ type: 'commandExecution', command: 'open -a Safari' }), false);
  assert.equal(isControlCall(null), false);
  assert.equal(liveOf(null), null);
  assert.equal(liveOf({ turn: 'idle', approvals: [{ id: 1 }] }), null);
  assert.equal(liveOf({ turn: 'awaitingUser' }), 'needs-you');
  assert.equal(liveOf({ turn: 'running', approvals: [{ id: 1 }] }), 'needs-you');
  assert.equal(liveOf({ turn: 'running', questions: [{ status: 'answered' }] }), 'running');
  assert.equal(liveOf({ turn: 'crashed' }), null);
});

test('a chat’s items are read again once the cache is 30 s old, even when its revision did not move (a late history write)', async () => {
  const { s, activity } = rig();
  s.chats.push({ chatId: 'm', updatedAt: NOW });
  s.turns.set('m', [turn('t1', NOW - 5, [ask('Old title'), nav('https://a.example')])]);
  await activity.list();
  s.turns.set('m', [turn('t1', NOW - 5, [ask('New title'), nav('https://a.example')])]);
  s.now += CACHE_MS - 1;
  assert.equal((await activity.list()).items[0].title, 'Old title');
  assert.equal(s.reads.length, 1);
  s.now += 1;
  assert.equal((await activity.list()).items[0].title, 'New title');
  assert.equal(s.reads.length, 2);
});

test('an errand keeps its id when its turn’s id changes (a running Claude Code turn, then its saved one); no start falls back to the id', async () => {
  const { s, activity } = rig();
  s.chats.push({ chatId: 'c', updatedAt: NOW });
  s.states.set('c', { turn: 'running' });
  s.turns.set('c', [
    turn('live-1', NOW - 50, [nav('https://a.example', 'inProgress')], 'inProgress'),
    turn('saved-x', null, [nav('https://b.example')]),
  ]);
  const first = (await activity.list()).items.map((i: any) => i.id);
  s.states.set('c', { turn: 'idle' });
  s.turns.set('c', [turn('transcript-9', NOW - 50, [nav('https://a.example')]), turn('saved-x', null, [nav('https://b.example')])]);
  s.versions.set('c', 1);
  const after = (await activity.list()).items.map((i: any) => i.id);
  assert.deepEqual(first, ['errand:c:saved-x', `errand:c:t${NOW - 50}`]);
  assert.deepEqual(after, first);
});

test('odd history shapes: a turn with no items, a non-object item, a call naming no tool, a chat with no write time, ties by id', async () => {
  const { s, activity } = rig();
  assert.equal(isControlCall({ type: 'mcpToolCall', server: 'mopilot_browser' }), true);
  s.runs.push({ chatId: 'r', taskId: 't', startedAt: NOW - 100 });
  s.turns.set('r', [null, { id: 'x' }, turn('t', NOW - 100, [null, 'text', nav('https://a.example')])]);
  // a chat no write time was recorded for: its turns with no start date it at 0, too old to list
  s.chats.push({ chatId: 'q' } as any);
  s.turns.set('q', [turn('t', null, [nav('https://b.example')])]);
  // same start: ordered by id, whichever order they come in
  for (const id of ['c', 'a', 'b']) s.runs.push({ chatId: id, taskId: 't', startedAt: NOW - 50 });
  const { items } = await activity.list();
  assert.deepEqual(
    items.map((i: any) => i.id),
    ['routine:a', 'routine:b', 'routine:c', 'routine:r'],
  );
  assert.deepEqual(
    items[3].steps.map((x: any) => x.text),
    ['Opened a.example'],
  );
});
