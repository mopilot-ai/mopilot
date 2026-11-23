// MoMo's Tasks list in main (electron/momo/tasks.cjs, tasksIpc.cjs): derived from the routine runs still going, the open loops that are awake and the momoAction cards waiting in MoMo's main chat, with ids made from the sources' own ids (so they are the same after a restart), the ones that need the user first, and nothing stored or completed here; the IPC refuses while MoMo is not allowed and tells the windows when the loops change.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { deriveTasks, waitingCards, MAX_TASKS, RUN_SHOWN_MS } = require('../electron/momo/tasks.cjs');
const { registerTasksIpc, CHANNELS, NOT_ALLOWED } = require('../electron/momo/tasksIpc.cjs');

const NOW = Date.UTC(2026, 10, 3, 12);
const H = 3_600_000;
const D = 24 * H;
const loop = (id: string, over: any = {}) => ({ id, text: `Loop ${id}`, quote: `said ${id}`, state: 'open', saidAt: NOW - D, ...over });
const card = (id: any, momo: any = { summary: `Send ${id}`, source: 'Mail' }) => ({ id, params: { kind: 'momoAction', momo } });
const run = (chatId: string, over: any = {}) => ({ chatId, taskId: 'r1', startedAt: NOW - H, ...over });
const derive = (o: any = {}) => deriveTasks({ runs: [], routineName: () => 'Daily brief', loops: [], cards: [], now: NOW, ...o });

test('each source becomes a task with its own id: a card, a loop and a run; the ones that need the user come first', () => {
  const tasks = derive({
    runs: [run('c-run')],
    loops: [loop('L1', { dueAt: NOW + D, quote: '' })],
    cards: [card(7)],
  });
  assert.deepEqual(
    tasks.map((t: any) => [t.id, t.kind, t.state, t.title, t.detail, t.ref]),
    [
      ['card:7', 'card', 'needs-you', 'Send 7', 'Mail', '7'],
      ['loop:L1', 'loop', 'needs-you', 'Loop L1', null, 'L1'],
      ['run:c-run', 'run', 'running', 'Daily brief', null, 'c-run'],
    ],
  );
  assert.equal(tasks[0].at, null);
  assert.equal(tasks[1].dueAt, NOW + D);
  assert.equal(tasks[1].dueDay, '2026-11-04');
  assert.equal(tasks[2].at, NOW - H);
});

test('ids are the same on every read and after a restart: they come from the sources, never from a counter or the clock', () => {
  const input = { runs: [run('c-run')], loops: [loop('L1'), loop('L2')], cards: [card('a1')] };
  const first = derive(input).map((t: any) => t.id);
  // a later read, a later clock, the lists in another order, as a restarted Mac reads them again
  const later = deriveTasks({
    runs: [...input.runs],
    routineName: () => 'Daily brief',
    loops: [...input.loops].reverse(),
    cards: [...input.cards],
    now: NOW + 60_000,
  }).map((t: any) => t.id);
  assert.deepEqual(first, ['card:a1', 'loop:L1', 'loop:L2', 'run:c-run']);
  assert.deepEqual([...later].sort(), [...first].sort());
  assert.equal(new Set(first).size, first.length);
});

test('a card without a summary or tool still says it needs the user; text is one line and bounded', () => {
  const [bare, tool, long] = derive({
    cards: [card(1, null), card(2, { tool: 'mail_send' }), card(3, { summary: `  a\n\n b ${'x'.repeat(500)}` })],
  });
  assert.deepEqual([bare.title, bare.detail], ['MoMo needs your OK', null]);
  assert.equal(tool.title, 'mail_send');
  assert.match(long.title, /^a b x+$/);
  assert.equal(long.title.length, 200);
  // a card with no params at all
  assert.equal(derive({ cards: [{ id: 9 }] })[0].title, 'MoMo needs your OK');
});

test('loops: only open ones that are awake; the soonest due first, then the undated, newest said first; a day alone keeps its day', () => {
  const tasks = derive({
    loops: [
      loop('undated-old', { saidAt: NOW - 3 * D }),
      loop('later', { dueAt: NOW + 5 * D }),
      loop('undated-new', { saidAt: NOW - D }),
      loop('soon', { dueAt: NOW + D, dueDay: '2026-11-04' }),
      loop('tie-b', { dueAt: NOW + 2 * D, saidAt: NOW }),
      loop('tie-a', { dueAt: NOW + 2 * D, saidAt: NOW }),
      loop('done', { state: 'done' }),
      loop('dismissed', { state: 'dismissed' }),
      loop('snoozed', { snoozedUntil: NOW + H }),
      loop('woke', { snoozedUntil: NOW - H }),
      loop('blank', { text: '   ', quote: undefined, saidAt: NOW - 2 * D }),
    ],
  });
  assert.deepEqual(
    tasks.map((t: any) => t.ref),
    ['soon', 'tie-a', 'tie-b', 'later', 'undated-new', 'woke', 'blank', 'undated-old'],
  );
  const soon = tasks.find((t: any) => t.ref === 'soon');
  assert.equal(soon.dueDay, '2026-11-04');
  assert.equal(tasks.find((t: any) => t.ref === 'blank').title, 'A reminder');
  assert.equal(tasks.find((t: any) => t.ref === 'undated-old').dueDay, null);
});

test('runs: only the ones that have not ended and are not older than a run may last; the newest first; a routine that is gone keeps a name', () => {
  const tasks = derive({
    runs: [
      run('old', { startedAt: NOW - RUN_SHOWN_MS - 1 }),
      run('ended', { endedAt: NOW - 1 }),
      run('a', { startedAt: NOW - 1.5 * H }),
      run('b', { startedAt: NOW - H }),
      run('c', { startedAt: NOW - H }),
    ],
    routineName: (id: string) => (id === 'r1' ? '' : null),
  });
  assert.deepEqual(
    tasks.map((t: any) => t.ref),
    ['b', 'c', 'a'],
  );
  assert.equal(tasks[0].title, 'A routine');
});

test('nothing completes a task: deriving changes none of its sources, and a task leaves only when its source ends', () => {
  const runs = [run('c-run')];
  const loops = [loop('L1')];
  const cards = [card(5)];
  const before = JSON.stringify({ runs, loops, cards });
  assert.equal(derive({ runs, loops, cards }).length, 3);
  assert.equal(JSON.stringify({ runs, loops, cards }), before);
  // the user marks the loop done (the loop store's own act), the card is answered, the run ends: each task is gone
  assert.deepEqual(derive({ runs: [{ ...runs[0], endedAt: NOW }], loops: [{ ...loops[0], state: 'done' }], cards: [] }), []);
});

test('the list is bounded, the ones that need the user kept first', () => {
  const tasks = derive({ runs: [run('r')], loops: Array.from({ length: MAX_TASKS + 20 }, (_, i) => loop(`L${i}`)) });
  assert.equal(tasks.length, MAX_TASKS);
  assert.equal(
    tasks.every((t: any) => t.kind === 'loop'),
    true,
  );
});

test('waiting cards: the momoAction cards of the main chat’s session, none before there is a main chat or a session', () => {
  const approvals = [card('m1'), { id: 'x', params: { kind: 'other' } }, { id: 'y' }, card('m2')];
  const controller = { state: { has: (id: string) => id === 'main', get: () => ({ approvals }) } };
  const ids = (c: any, chat: string | null) => waitingCards(c, { mainChatId: () => chat }).map((a: any) => a.id);
  assert.deepEqual(ids(controller, 'main'), ['m1', 'm2']);
  assert.deepEqual(ids(controller, null), []);
  assert.deepEqual(ids(controller, 'other'), []);
  assert.deepEqual(ids(undefined, 'main'), []);
  assert.deepEqual(ids({}, 'main'), []);
});

function ipcRig(o: { allowed?: boolean; fail?: boolean } = {}) {
  const handlers = new Map<string, Function>();
  const ipcMain = { handle: (ch: string, fn: Function) => handlers.set(ch, fn), removeHandler: (ch: string) => handlers.delete(ch) };
  const loops: any = new EventEmitter();
  loops.items = [loop('L1')];
  loops.list = () => {
    if (o.fail) throw new Error('disk is gone');
    return loops.items;
  };
  const gate = { allowed: o.allowed ?? true };
  const told: string[] = [];
  const asked: number[] = [];
  const off = registerTasksIpc(ipcMain, {
    loops,
    runsSince: (at: number) => (asked.push(at), [run('c-run')]),
    routineName: () => 'Daily brief',
    cards: () => [card('k1')],
    allowed: () => gate.allowed,
    broadcast: (ch: string) => told.push(ch),
    now: () => NOW,
  });
  return { handlers, loops, gate, told, asked, off, list: () => handlers.get('momoTasks:list')!() };
}

test('momoTasks:list answers the tasks and the time; runs are asked for from the longest a run may last', async () => {
  const r = ipcRig();
  assert.deepEqual(CHANNELS, ['momoTasks:list', 'momoTasks:mark']);
  const res: any = await r.list();
  assert.equal(res.ok, true);
  assert.equal(res.now, NOW);
  assert.deepEqual(
    res.tasks.map((t: any) => t.id),
    ['card:k1', 'loop:L1', 'run:c-run'],
  );
  assert.deepEqual(r.asked, [NOW - RUN_SHOWN_MS]);
});

test('momoTasks:list is refused while MoMo is not allowed, and a read that fails says why', async () => {
  const off = ipcRig({ allowed: false });
  assert.deepEqual(await off.list(), { ok: false, reason: 'not_allowed', error: 'MoMo is not available' });
  assert.deepEqual(off.asked, []);
  const bad: any = await ipcRig({ fail: true }).list();
  assert.deepEqual([bad.ok, bad.error], [false, 'disk is gone']);
});

test('a change of the loops is told to the windows only while MoMo is allowed; removing the handler stops it', () => {
  const r = ipcRig();
  r.loops.emit('changed');
  assert.deepEqual(r.told, ['momoTasks:changed']);
  r.gate.allowed = false;
  r.loops.emit('changed');
  assert.deepEqual(r.told, ['momoTasks:changed']);
  r.off();
  r.gate.allowed = true;
  r.loops.emit('changed');
  assert.equal(r.told.length, 1);
  assert.equal(r.handlers.has('momoTasks:list'), false);
});

test('without a broadcast, a change of the loops tells nobody and breaks nothing', () => {
  const handlers = new Map<string, Function>();
  const loops: any = Object.assign(new EventEmitter(), { list: () => [] });
  registerTasksIpc(
    { handle: (ch: string, fn: Function) => handlers.set(ch, fn), removeHandler: () => undefined },
    { loops, runsSince: () => [], routineName: () => null, cards: () => [], allowed: () => true },
  );
  loops.emit('changed');
  assert.equal(handlers.has('momoTasks:list'), true);
});

test('the two values repeated so this feature imports nothing that writes to disk stay equal to their owners', () => {
  assert.equal(RUN_SHOWN_MS, require('../electron/momo/routineRuns.cjs').MAX_RUN_MS);
  assert.deepEqual(NOT_ALLOWED, require('../electron/momo/memoryIpc.cjs').NOT_ALLOWED);
});

test('the window’s Tasks types are a module of types alone: loading it brings nothing in', async () => {
  const mod = await import('../src/lib/native/contracts/momoTasks.ts');
  assert.equal(typeof mod, 'object');
});
