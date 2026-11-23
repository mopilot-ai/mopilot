// src/store/codexDisk.ts with threads.ts and connection.ts: while Codex is down, a Codex chat shows its history read
// from its rollout file instead of an empty page, read-only; once Codex is back, a read from it replaces that, and a
// read from it that starts while the file is being read wins over it.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, bootImpls, listeners } from './support/store-harness.ts';
import { controlledReads } from './support/async-scenarios.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
const S = store;
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const disk = await import('../src/store/codexDisk.ts');
const { held } = await import('../src/store/threads.ts');
const { HARNESS_DOWN } = await import('../src/store/harnessDown.ts');
const { readStale, readSucceeded } = await import('../src/store/chatReads.ts');
const turn = (id: string) => ({ id, status: 'completed', items: [], startedAt: 1, completedAt: 2, durationMs: 1000, error: null });
const DOWN = "Codex isn't connected";

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  bootImpls();
  impl['session.snapshot'] = async () => null;
  impl['api.threadRead'] = async (id: string) => ({ thread: { id } });
});

/** Codex as main has it: down until it is connected again; the chat's rollout file holds `onDisk`. */
function codex({ onDisk = ['d1', 'd2'] as string[] | null, cursor = 'rollout:4' as string | null } = {}) {
  const state = { down: true };
  impl['api.threadTurns'] = async () => {
    if (state.down) throw new Error(DOWN);
    return { data: [turn('s1')], nextCursor: null };
  };
  impl['codex.connect'] = async () => {
    state.down = false;
    return { codexHome: '/home/me/.codex', userAgent: 'ua' };
  };
  impl['codex.rolloutHistory'] = async () => onDisk && { path: '/r', cwd: '/w', turns: onDisk.map(turn), nextCursor: cursor };
  return state;
}

test('Codex down: a Codex chat shows its latest turns from its rollout file, read-only, with no error', async () => {
  codex();
  set({ conn: 'error', codexRestart: 'gaveUp', threads: { c1: { id: 'c1', path: '/codex/sessions/rollout-x-c1.jsonl' } } as any });
  await S.openThread('c1');
  const rt = st().runtime.c1;
  assert.deepEqual(
    rt.turns.map((t) => t.id),
    ['d1', 'd2'],
  );
  assert.equal(rt.fromDisk, true);
  assert.equal(rt.error, null);
  assert.equal(rt.loaded, true);
  assert.equal(rt.loading, false);
  assert.equal(rt.activeTurnId, null);
  assert.equal(rt.olderCursor, 'rollout:4');
  // where the app-server last said its file is, and a page of the latest turns
  assert.deepEqual(callsOf('codex.rolloutHistory'), [['c1', { hint: '/codex/sessions/rollout-x-c1.jsonl', limit: 30 }]]);
  // an older page comes from the same file
  impl['codex.rolloutHistory'] = async () => ({ path: '/r', cwd: '/w', turns: [turn('d0')], nextCursor: null });
  await S.loadOlderTurns('c1');
  assert.deepEqual(
    st().runtime.c1.turns.map((t) => t.id),
    ['d0', 'd1', 'd2'],
  );
  assert.deepEqual(callsOf('codex.rolloutHistory')[1], [
    'c1',
    { hint: '/codex/sessions/rollout-x-c1.jsonl', cursor: 'rollout:4', limit: 30 },
  ]);
  // a file that is gone by the next page reads as its oldest
  impl['codex.rolloutHistory'] = async () => null;
  set((s) => ({ runtime: { ...s.runtime, c1: { ...s.runtime.c1, olderCursor: 'rollout:1' } } }));
  await S.loadOlderTurns('c1');
  assert.equal(st().runtime.c1.olderCursor, null);
});

test('Codex down with no rollout file, or one that cannot be read: the read says why, with Retry', async () => {
  codex({ onDisk: null });
  set({ conn: 'error' });
  await S.openThread('none');
  assert.equal(st().runtime.none.error, DOWN);
  assert.equal(st().runtime.none.fromDisk, undefined);
  impl['codex.rolloutHistory'] = async () => {
    throw new Error('bad frame');
  };
  await S.openThread('broken');
  assert.equal(st().runtime.broken.error, DOWN);
  assert.equal(st().runtime.broken.errorFromRead, true);
});

test('a read that fails while Codex is up says why, and never reads the file', async () => {
  impl['api.threadTurns'] = async () => {
    throw new Error('read failed');
  };
  set({ conn: 'ready', codexRestart: null, connError: null });
  await S.openThread('up');
  assert.equal(st().runtime.up.error, 'read failed');
  assert.equal(callsOf('codex.rolloutHistory').length, 0);
});

test('Codex quitting (its error said, before main restarts it) or being restarted by main also counts as down', () => {
  assert.equal(disk.codexDown({ conn: 'ready', codexRestart: null, connError: 'exited (1)' } as any), true);
  assert.equal(disk.codexDown({ conn: 'ready', codexRestart: { attempt: 1, inMs: 1000 }, connError: null } as any), true);
  assert.equal(disk.codexDown({ conn: 'ready', codexRestart: null, connError: null } as any), false);
});

test('Codex back: the chats shown from disk on screen are read from it again, and that read replaces what disk showed', async () => {
  const state = codex();
  set({ conn: 'error', route: { name: 'thread', id: 'shown' } as any, paneTabs: [{ threadId: 'pane' }] as any });
  await S.openThread('shown');
  await S.openThread('pane');
  await S.openThread('hidden');
  assert.equal(st().runtime.pane.fromDisk, true);
  state.down = false;
  await S.connect(true);
  await flush();
  for (const id of ['shown', 'pane']) {
    assert.deepEqual(
      st().runtime[id].turns.map((t) => t.id),
      ['s1'],
      id,
    );
    assert.equal(st().runtime[id].fromDisk, false, id);
  }
  // off screen: it reads again when it is opened
  assert.equal(st().runtime.hidden.fromDisk, true);
  await S.openThread('hidden');
  assert.equal(st().runtime.hidden.fromDisk, false);
});

test('a read from Codex that starts while the file is read wins: the file read publishes nothing', async () => {
  const state = codex();
  let release!: () => void;
  impl['codex.rolloutHistory'] = () =>
    new Promise((r) => (release = () => r({ path: '/r', cwd: '/w', turns: [turn('d1')], nextCursor: null })));
  set({ conn: 'error' });
  const first = S.openThread('race');
  await flush();
  assert.ok(disk.readingDisk.has('race'));
  assert.equal(st().runtime.race.loading, true);
  // Codex is back and the chat is read from it, though the file read is still loading the chat
  state.down = false;
  set({ conn: 'ready', connError: null, codexRestart: null });
  await S.openThread('race');
  release();
  await first;
  await flush();
  assert.deepEqual(
    st().runtime.race.turns.map((t) => t.id),
    ['s1'],
  );
  assert.equal(st().runtime.race.fromDisk, undefined);
  assert.equal(st().runtime.race.loading, false);
});

test('Codex back while the file is read, with nothing reading the chat from it: the chat is read from Codex next', async () => {
  const state = codex();
  let release!: () => void;
  impl['codex.rolloutHistory'] = () =>
    new Promise((r) => (release = () => r({ path: '/r', cwd: '/w', turns: [turn('d1')], nextCursor: null })));
  set({ conn: 'error' });
  const reading = S.openThread('late');
  await flush();
  state.down = false;
  set({ conn: 'ready', connError: null, codexRestart: null });
  release();
  await reading;
  // the file's turns are never shown with Codex up; the chat is read from it once the file read let go
  assert.equal(st().runtime.late.fromDisk, undefined);
  assert.equal(st().runtime.late.loading, false);
  mock.timers.tick(0);
  await flush();
  assert.deepEqual(
    st().runtime.late.turns.map((t) => t.id),
    ['s1'],
  );
});

test('two reads while Codex stays down: the later one shows the file; the earlier one publishes nothing', async () => {
  codex();
  const releases: (() => void)[] = [];
  let n = 0;
  impl['codex.rolloutHistory'] = () =>
    new Promise((r) => {
      const ids = [`f${++n}`];
      releases.push(() => r({ path: '/r', cwd: '/w', turns: ids.map(turn), nextCursor: null }));
    });
  set({ conn: 'error' });
  const a = S.openThread('twice');
  await flush();
  const b = S.openThread('twice');
  await flush();
  releases[1]();
  await b;
  releases[0]();
  await a;
  assert.deepEqual(
    st().runtime.twice.turns.map((t) => t.id),
    ['f2'],
  );
});

for (const live of ['completed', 'buffered delta'])
  test(`initial disk history recovers when a ${live} retires its snapshot`, async () => {
    const id = `disk-live-${live}`;
    codex();
    set({ conn: 'error' });
    const tail = (text: string) => ({ ...turn('current'), items: [{ type: 'agentMessage', id: 'reply', text }] });
    const older = {
      ...turn('older'),
      status: 'interrupted',
      items: [
        { type: 'userMessage', id: 'original-prompt', content: [{ type: 'text', text: 'The original user prompt' }] },
        { type: 'agentMessage', id: 'original-update', text: 'An earlier assistant update', phase: 'commentary' },
        { type: 'commandExecution', id: 'original-tool', status: 'completed', command: 'Inspect', aggregatedOutput: 'Evidence' },
      ],
    };
    const page = { path: '/r', cwd: '/w', turns: [older, tail('Hello')], nextCursor: null };
    const diskReads = controlledReads<any>();
    let reads = 0;
    impl['codex.rolloutHistory'] = () => (++reads === 1 ? diskReads.read() : Promise.resolve(page));
    S.patchRuntime(id, () => ({ turns: [{ ...tail('Hel'), itemTimes: {} }] as any }));
    const opening = S.openThread(id);
    await flush();
    const event =
      live === 'completed'
        ? { method: 'item/completed', params: { threadId: id, turnId: 'current', item: tail('Hello').items[0] } }
        : { method: 'item/agentMessage/delta', params: { threadId: id, turnId: 'current', itemId: 'reply', delta: 'lo' } };
    listeners['codex.onItem']({ kind: 'notification', ...event });
    diskReads.requests[0].resolve(page);
    await opening;
    mock.timers.tick(1000);
    await flush();
    const rt = st().runtime[id];
    assert.equal(rt.turns.at(-1)?.items[0].text, 'Hello', 'a queued delta must not be appended to an already updated disk page');
    assert.equal(rt.loaded, true, 'retiring a disk snapshot must not leave only the live tail');
    assert.equal(rt.loading, false);
    assert.equal(rt.error, null);
    assert.equal(rt.fromDisk, true);
    assert.deepEqual(
      rt.turns.map((t) => t.id),
      ['older', 'current'],
    );
    assert.deepEqual(
      rt.turns[0].items.map((item) => item.id),
      ['original-prompt', 'original-update', 'original-tool'],
    );
    assert.equal(reads, 2, 'the same opener gets a fresh snapshot without another navigation');
  });

test('a held chat stays read from disk until a real Codex page replaces that history', async () => {
  const state = codex();
  set({ conn: 'error' });
  await S.openThread('mine');
  assert.equal(st().runtime.mine.fromDisk, true);
  held.add('mine');
  await S.openThread('mine');
  assert.equal(st().runtime.mine.fromDisk, true);
  state.down = false;
  await S.openThread('mine');
  assert.equal(st().runtime.mine.fromDisk, false);
  assert.equal(st().runtime.mine.turns[0].id, 's1');
  held.delete('mine');
});

for (const loaded of [false, true])
  test(`an empty disk fallback cannot publish a stale failure after live progress (${loaded ? 'loaded' : 'initial'} history)`, async () => {
    const id = `empty-disk-live-${loaded}`;
    codex();
    set({ conn: 'error' });
    const tail = (text: string) => ({ ...turn('current'), itemTimes: {}, items: [{ type: 'agentMessage', id: 'reply', text }] });
    S.patchRuntime(id, () => ({ loaded, turns: loaded ? [turn('older'), tail('Hel')] : [tail('Hel')] }));
    const reads = controlledReads<any>();
    let diskReads = 0;
    impl['codex.rolloutHistory'] = () =>
      ++diskReads === 1
        ? reads.read()
        : Promise.resolve({ path: '/r', cwd: '/w', turns: [turn('older'), tail('Hello')], nextCursor: null });
    const opening = S.openThread(id);
    await flush();
    reads.requests[0].resolve(null);
    let fallbackSettledBeforeProgress = false;
    // The next queued native callback lands after the empty fallback settles, before its caller can publish the error.
    queueMicrotask(() =>
      queueMicrotask(() => {
        fallbackSettledBeforeProgress = !disk.readingDisk.has(id);
        listeners['codex.onItem']({
          kind: 'notification',
          method: 'item/completed',
          params: { threadId: id, turnId: 'current', item: tail('Hello').items[0] },
        });
      }),
    );
    await opening;
    assert.equal(fallbackSettledBeforeProgress, true, 'the live callback follows the fallback result, before error publication');
    assert.equal(st().runtime[id].error, null);
    assert.equal(st().runtime[id].loaded, true);
    assert.equal(st().runtime[id].loading, false);
    assert.deepEqual(
      st().runtime[id].turns.map((t) => t.id),
      ['older', 'current'],
    );
    assert.equal(st().runtime[id].turns[1].items[0].text, 'Hello');
    assert.equal(diskReads, loaded ? 1 : 2, 'only initial history owes a replacement read');
  });

test('what a later read replaces: an error from a read, or turns from disk', () => {
  const rt = (o: object) => ({ turns: [], error: null, ...o }) as any;
  assert.equal(readStale(rt({})), false);
  assert.equal(readStale(rt({ errorFromRead: true, error: 'x' })), true);
  assert.equal(readStale(rt({ fromDisk: true })), true);
  assert.deepEqual(readSucceeded(rt({ fromDisk: true, errorFromRead: true, error: 'x' })), {
    error: null,
    errorFromRead: false,
    fromDisk: false,
  });
  assert.deepEqual(readSucceeded(rt({ error: 'refused' })), {});
});

test("a switched chat's Codex part: all of it from disk while Codex is down, none of it once Codex is up", async () => {
  set({ conn: 'error' });
  impl['codex.rolloutHistory'] = async (_id: string, o: any) => ({
    path: '/r',
    cwd: '/w',
    turns: [turn('a'), turn('b')],
    nextCursor: null,
    o,
  });
  assert.deepEqual(
    (await disk.allFromDisk('t'))?.map((t) => t.id),
    ['a', 'b'],
  );
  // the whole thread: no page limit
  assert.deepEqual(callsOf('codex.rolloutHistory').at(-1), ['t', { hint: null }]);
  impl['codex.rolloutHistory'] = async () => {
    throw new Error('bad frame');
  };
  assert.equal(await disk.allFromDisk('t'), null);
  impl['codex.rolloutHistory'] = async () => null;
  assert.equal(await disk.allFromDisk('t'), null);
  set({ conn: 'ready', connError: null, codexRestart: null });
  assert.equal(await disk.allFromDisk('t'), null);
});

test("Codex's harness is down once nothing brings it back; while main restarts it, the composer stays", () => {
  assert.equal(HARNESS_DOWN.codex.down({ conn: 'error', codexRestart: 'gaveUp', connError: 'exited' } as any), true);
  // main bringing a crashed Codex back by itself: reads fail (the disk stands in), but a message can wait for it
  const restarting = { conn: 'ready', codexRestart: { attempt: 1, inMs: 1000 }, connError: 'exited (1)' } as any;
  assert.equal(HARNESS_DOWN.codex.down(restarting), false);
  assert.equal(disk.codexDown(restarting), true);
  assert.equal(HARNESS_DOWN.codex.restart, S.restartCodex);
  for (const family of ['claude', 'acp'] as const) {
    assert.equal(HARNESS_DOWN[family].down({ conn: 'error' } as any), false);
    assert.equal(HARNESS_DOWN[family].restart, null);
  }
});

test('an older page of a chat read from Codex comes from Codex', async () => {
  impl['api.threadTurns'] = async (_id: string, p: any) =>
    p.cursor ? { data: [turn('o2'), turn('o1')], nextCursor: null } : { data: [turn('n1')], nextCursor: 'c1' };
  set({ conn: 'ready', codexRestart: null, connError: null });
  await S.openThread('paged');
  await S.loadOlderTurns('paged');
  assert.deepEqual(
    st().runtime.paged.turns.map((t) => t.id),
    ['o1', 'o2', 'n1'],
  );
  assert.equal(callsOf('codex.rolloutHistory').length, 0);
});

test("a turn the file leaves unfinished shows as interrupted; a file with no messages leaves the read's error", async () => {
  codex();
  impl['codex.rolloutHistory'] = async () => ({
    path: '/r',
    cwd: '/w',
    turns: [turn('done'), { ...turn('cut'), status: 'inProgress' }],
    nextCursor: null,
  });
  set({ conn: 'error' });
  await S.openThread('cut-off');
  assert.deepEqual(
    st().runtime['cut-off'].turns.map((t) => t.status),
    ['completed', 'interrupted'],
  );
  impl['codex.rolloutHistory'] = async () => ({ path: '/r', cwd: '/w', turns: [], nextCursor: null });
  await S.openThread('empty');
  assert.equal(st().runtime.empty.error, DOWN);
  assert.equal(st().runtime.empty.fromDisk, undefined);
});

test('a switched chat read from disk is read again when opened; one read from Codex is not', async () => {
  set({ segments: { sw: [{ harness: 'codex', nativeId: 'sw', start: 0 }] } as any });
  set((s) => ({ runtime: { ...s.runtime, sw: { ...(s.runtime.sw ?? {}), turns: [], loaded: true, fromDisk: true } as any } }));
  await S.openThread('sw');
  assert.equal(callsOf('switch.openCompositeThread').length, 1);
  set((s) => ({ runtime: { ...s.runtime, sw: { ...s.runtime.sw, fromDisk: false } } }));
  await S.openThread('sw');
  assert.equal(callsOf('switch.openCompositeThread').length, 1);
});
