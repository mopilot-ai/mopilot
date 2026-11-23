// MoMo task ledger (shared/momoTasks/store.ts): validation on read, stable-key idempotence, the working cap, pruning, atomic updates and Reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createItemStore, createMemorySeam, KEEP_MS, MAX_ITEMS, parseItem, TASKS_STORE_ID } from '../shared/momoTasks/store.ts';
import type { Item } from '../shared/momoTasks/types.ts';

const item = (id: string, over: Partial<Item> = {}): Item => ({
  id,
  title: `T ${id}`,
  doneMeans: 'd',
  state: 'working',
  where: { machineId: 'm', harness: 'claude', sessionId: null, machineName: null },
  origin: 'asked',
  stableKey: `k${id}`,
  attempts: 0,
  attemptCap: 3,
  lastError: null,
  result: null,
  progress: null,
  cardId: null,
  watch: null,
  nextCheck: null,
  createdAt: 1,
  startedAt: null,
  updatedAt: 1,
  settled: 0,
  posted: 0,
  card: null,
  notice: null,
  failedWith: null,
  ...over,
});
const clock = (t = 1000) => ({ now: () => t });

test('the store registers as "tasks" in Reset MoMo', () => assert.equal(TASKS_STORE_ID, 'tasks'));

test('a stored item is kept only when whole; damage is dropped, never guessed', () => {
  assert.deepEqual(parseItem(JSON.parse(JSON.stringify(item('a')))), item('a'));
  const full = item('b', {
    lastError: { code: 'interrupted', message: 'm', fixes: [], retry: false, at: 1 },
    result: { summary: 's', files: [], evidence: '', checked: '', met: true },
    progress: 'p',
    cardId: 'c',
    nextCheck: 5,
    startedAt: 2,
    watch: { watch: { kind: 'tool', tool: 't', everyMinutes: 5 }, state: null, retryAt: null },
  });
  assert.deepEqual(parseItem(JSON.parse(JSON.stringify(full))), full);
  // old documents without the card counters read as nothing owed
  const { settled, posted, ...old } = item('c');
  assert.deepEqual([parseItem(old)?.settled, parseItem(old)?.posted], [0, 0]);
  const bad: unknown[] = [
    null,
    3,
    [],
    { ...item('x'), where: null },
    { ...item('x'), id: 1 },
    { ...item('x'), title: 1 },
    { ...item('x'), doneMeans: 1 },
    { ...item('x'), stableKey: 1 },
    { ...item('x'), state: 'running' },
    { ...item('x'), origin: 'robot' },
    { ...item('x'), where: { machineId: 1, harness: 'a', sessionId: null } },
    { ...item('x'), where: { machineId: 'm', harness: 'a', sessionId: 5 } },
    { ...item('x'), attempts: 'x' },
    { ...item('x'), updatedAt: NaN },
  ];
  for (const b of bad) assert.equal(parseItem(b), null);
  const loose = parseItem({ ...item('d'), lastError: { code: 1 }, result: 'x', watch: { watch: 1 }, progress: 4, nextCheck: 'x' }) as Item;
  assert.deepEqual([loose.lastError, loose.result, loose.watch, loose.progress, loose.nextCheck], [null, null, null, null, null]);
});

test('a document that is not a ledger is refused; a damaged entry and a repeated id are dropped', async () => {
  for (const raw of [{ v: 1, items: 'x' }, 'text', { v: 0, items: [] }, { items: [] }])
    await assert.rejects(createItemStore(createMemorySeam(raw), clock()).list(), /damaged/);
  assert.deepEqual(await createItemStore(createMemorySeam(null), clock()).list(), []);
  const store = createItemStore(
    createMemorySeam({ v: 1, items: [item('a'), { junk: true }, item('a', { title: 'again' }), item('b')] }),
    clock(),
  );
  assert.deepEqual(
    (await store.list()).map((i) => [i.id, i.title]),
    [
      ['a', 'T a'],
      ['b', 'T b'],
    ],
  );
});

test('insert returns the existing item for a stable key and stops at the working cap', async () => {
  const store = createItemStore(createMemorySeam(), clock());
  const first = await store.insertOrGet(item('a'), 2);
  assert.deepEqual([(first as any).created, (first as any).item.id], [true, 'a']);
  const again = await store.insertOrGet(item('z', { stableKey: 'ka' }), 2);
  assert.deepEqual([(again as any).created, (again as any).item.id], [false, 'a']);
  await store.insertOrGet(item('b'), 2);
  assert.deepEqual(await store.insertOrGet(item('c'), 2), { full: true });
  // waiting, watching and finished items do not count as working
  await store.update('a', (i) => ({ ...i, state: 'needs_you' }));
  assert.equal(((await store.insertOrGet(item('c'), 2)) as any).created, true);
});

test('lookups by id and by session, and an atomic update that may decline', async () => {
  const store = createItemStore(createMemorySeam(), clock());
  await store.insertOrGet(item('a', { where: { machineId: 'm', harness: 'claude', sessionId: 's1' } }), 5);
  assert.equal((await store.get('a'))?.id, 'a');
  assert.equal(await store.get('nope'), null);
  assert.equal((await store.bySession('m', 's1'))?.id, 'a');
  assert.equal(await store.bySession('other', 's1'), null);
  assert.equal(await store.update('nope', (i) => i), null);
  assert.equal((await store.update('a', () => null))?.id, 'a');
  assert.equal((await store.update('a', (i) => ({ ...i, title: 'New' })))?.title, 'New');
  assert.equal((await store.get('a'))?.title, 'New');
});

test('concurrent updates run one after another, none lost', async () => {
  const store = createItemStore(createMemorySeam(), clock());
  await store.insertOrGet(item('a'), 5);
  await Promise.all(Array.from({ length: 20 }, () => store.update('a', (i) => ({ ...i, attempts: i.attempts + 1 }))));
  assert.equal((await store.get('a'))?.attempts, 20);
  // a failing change does not wedge the queue
  const seam = createMemorySeam();
  await assert.rejects(
    seam.change(() => {
      throw new Error('boom');
    }),
  );
  assert.equal(await seam.change(() => ({ doc: 1, out: 'next' })), 'next');
  assert.equal(seam.snapshot(), 1);
});

test('old finished items are pruned, the newest 200 stay, and live items are never dropped', async () => {
  const t = 100 * 24 * 3_600_000;
  const store = createItemStore(createMemorySeam(), clock(t));
  await store.insertOrGet(item('live', { updatedAt: 1 }), 9);
  await store.insertOrGet(item('watch', { state: 'watching', updatedAt: 1 }), 9);
  await store.insertOrGet(item('old', { state: 'done', updatedAt: t - KEEP_MS - 1 }), 9);
  await store.insertOrGet(item('new', { state: 'done', updatedAt: t - 1 }), 9);
  assert.deepEqual((await store.list()).map((i) => i.id).sort(), ['live', 'new', 'watch']);
  const crowded = createItemStore(
    createMemorySeam({
      v: 1,
      items: Array.from({ length: MAX_ITEMS + 10 }, (_, i) => item(`d${i}`, { state: 'failed', updatedAt: t - 1000 + i })),
    }),
    clock(t),
  );
  await crowded.insertOrGet(item('live2'), 9);
  const ids = (await crowded.list()).map((i) => i.id);
  assert.equal(ids.length, MAX_ITEMS);
  assert.ok(ids.includes('live2') && ids.includes(`d${MAX_ITEMS + 9}`) && !ids.includes('d0'));
});

test('Reset MoMo deletes every item', async () => {
  const seam = createMemorySeam();
  const store = createItemStore(seam, clock());
  await store.insertOrGet(item('a'), 5);
  await store.reset();
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(seam.snapshot(), { v: 1, items: [] });
});

test('a retry takes a working slot only while fewer than the cap are working; no such item is nothing', async () => {
  const store = createItemStore(createMemorySeam(), clock());
  await store.insertOrGet(item('a', { state: 'working' }), 9);
  await store.insertOrGet(item('b', { state: 'working' }), 9);
  await store.insertOrGet(item('c', { state: 'stopped' }), 9);
  assert.deepEqual(await store.reopen('c', 2), { full: true });
  assert.equal((await store.get('c'))?.state, 'stopped');
  assert.equal(((await store.reopen('c', 3)) as { item: Item }).item.state, 'working');
  // the item itself does not count against the cap
  assert.equal(((await store.reopen('a', 3)) as { item: Item }).item.state, 'working');
  assert.equal(await store.reopen('nope', 2), null);
});
