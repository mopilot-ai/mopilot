// Minimal scripted reproductions of the task-lifecycle defects the interleaving suite found, now guards (F1 to F4 were fixed in runs.ts and store.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { words } from './support/momoTaskItems/words.ts';
import { MAX_WORKING, createTaskManager } from '../shared/momoTasks/manager.ts';
import { createItemStore, createMemorySeam } from '../shared/momoTasks/store.ts';
import type { ResultCard, StartOutcome } from '../shared/momoTasks/types.ts';

/** One idempotent fake Host (the same start key answers the same session) and nothing else random. */
function world() {
  let n = 0;
  const live = new Set<string>();
  const byKey = new Map<string, string>();
  const stops: string[] = [];
  const cards: ResultCard[] = [];
  const clock = { now: () => 1_000_000 + ++n };
  const mgr = createTaskManager({
    words,
    store: createItemStore(createMemorySeam(), clock),
    clock,
    randomId: () => `r${++n}`,
    home: async () => ({ machineId: 'home', harness: 'claude' }),
    machines: {
      list: async () => [
        {
          machineId: 'home',
          name: 'home',
          online: true,
          outdated: false,
          installable: true,
          agents: [{ id: 'claude', state: 'ready' as const }],
        },
      ],
      start: async (req): Promise<StartOutcome> => {
        await Promise.resolve();
        let id = byKey.get(req.key);
        if (!id) {
          id = `s${byKey.size + 1}`;
          byKey.set(req.key, id);
          live.add(id);
        }
        return { ok: true, sessionId: id };
      },
      stop: async (_m, sid) => {
        stops.push(sid);
        live.delete(sid);
      },
      probe: async () => ({ state: 'running' }),
    },
    check: { ask: async () => '{"met": true, "reason": "ok", "checked": "opened it"}' },
    chat: { postResult: async (c) => void cards.push(c), postWatchChanged: async () => {} },
  });
  const make = (title: string) => mgr.create({ title, doneMeans: `${title} is complete`, origin: 'asked', userStarted: true });
  return { mgr, live, stops, cards, make };
}
const REPORT = 'Result: made it.\nFiles: a.txt\nEvidence: opened a.txt';

test('guard: a stale event from an earlier attempt changes nothing', async () => {
  const w = world();
  const { item } = await w.make('Collect invoices');
  await w.mgr.onEvent('home', item.where.sessionId as string, { kind: 'failed', message: 'crashed' });
  const retried = (await w.mgr.retry(item.id)).item;
  assert.notEqual(retried.where.sessionId, item.where.sessionId);
  const before = JSON.stringify(await w.mgr.list());
  await w.mgr.onEvent('home', item.where.sessionId as string, { kind: 'finished', report: REPORT });
  assert.equal(JSON.stringify(await w.mgr.list()), before);
  assert.equal(w.cards.length, 1);
});

test('guard: a late finished after stop, and a second stop, change nothing and make no card', async () => {
  const w = world();
  const { item } = await w.make('Tidy the photos');
  await w.mgr.stop(item.id);
  await assert.rejects(w.mgr.stop(item.id));
  await w.mgr.onEvent('home', item.where.sessionId as string, { kind: 'finished', report: REPORT });
  assert.equal((await w.mgr.get(item.id))?.state, 'stopped');
  assert.deepEqual([w.stops, w.cards.length], [[item.where.sessionId], 0]);
});

test('F1: a retry past five working tasks is refused (the cap holds for a retry too)', async () => {
  const w = world();
  const first = await w.make('Task 0');
  for (let i = 1; i < MAX_WORKING; i++) await w.make(`Task ${i}`);
  await w.mgr.stop(first.item.id);
  await w.make('Task 5');
  await w.mgr.retry(first.item.id);
  const working = (await w.mgr.list()).filter((i) => i.state === 'working').length;
  assert.ok(working <= MAX_WORKING, `${working} tasks working`);
});

test('F2: two retries at once on one failed task stop the session the first one started', async () => {
  const w = world();
  const { item } = await w.make('Draft the visa form');
  await w.mgr.onEvent('home', item.where.sessionId as string, { kind: 'failed', message: 'crashed' });
  await Promise.all([w.mgr.retry(item.id).catch(() => {}), w.mgr.retry(item.id).catch(() => {})]);
  const now = (await w.mgr.get(item.id))!;
  assert.equal(now.state, 'working');
  assert.ok(w.live.has(now.where.sessionId as string), 'the working task points at a dead session');
});

test('F3: a retry while the session waits (needs_you with no card id) starts a second live session', async () => {
  const w = world();
  const { item } = await w.make('Check the lease');
  await w.mgr.onEvent('home', item.where.sessionId as string, { kind: 'needs_you', line: 'which lease?' });
  await w.mgr.retry(item.id).catch(() => {});
  assert.ok(w.live.size <= 1, `${w.live.size} sessions live for one task`);
});

test('F4: finished after a needs_you with no card id is dropped, the task never settles', async () => {
  const w = world();
  const { item } = await w.make('Summarise the board notes');
  await w.mgr.onEvent('home', item.where.sessionId as string, { kind: 'needs_you', line: 'which notes?' });
  await w.mgr.onEvent('home', item.where.sessionId as string, { kind: 'finished', report: REPORT });
  const now = (await w.mgr.get(item.id))!;
  assert.ok(now.state === 'done' || now.settled === 1, `state ${now.state}, ${w.cards.length} cards`);
});
