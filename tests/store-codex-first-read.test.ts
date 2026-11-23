// Initial Codex history recovers from live updates while preserving read ownership, source switches and local takeover.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, listeners, bootImpls } from './support/store-harness.ts';
import { controlledReads } from './support/async-scenarios.ts';
import { deletionVisibility } from '../src/store/deletionVisibility.ts';
import { beginHistoryOpen } from '../src/store/transcriptRead.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, sessions, resetState } = await loadStore();
const S = store;
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const item = (e: any) => listeners['codex.onItem'](e);
const serverTurn = (id: string, o: any = {}) => ({
  id,
  status: 'completed',
  items: [],
  startedAt: 1,
  completedAt: 2,
  durationMs: 1000,
  error: null,
  ...o,
});

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
});

test('a Codex initial read spanning a complete local lease cannot revive that local turn as external work', async () => {
  const id = 'initial-local-turn';
  const reads = controlledReads<any>();
  impl['api.threadRead'] = async () => ({ thread: { id, path: '/rollout' } });
  impl['api.threadTurns'] = reads.read;
  const pending = S.openThread(id);
  item({ kind: 'lease', threadId: id, held: true });
  const local = serverTurn('local-turn');
  S.patchRuntime(id, () => ({ turns: [local] }));
  item({ kind: 'lease', threadId: id, held: false, reason: 'released' });
  reads.requests[0].resolve({ data: [serverTurn('local-turn', { status: 'inProgress' })], nextCursor: null });
  await flush();
  assert.equal(st().runtime[id].turns[0], local);
  assert.equal(st().elsewhere[id], undefined);
  assert.equal(st().runtime[id].loading, true);
  // Retirement starts a fresh read without requiring another navigation.
  reads.requests[1].resolve({ data: [serverTurn('local-turn')], nextCursor: null });
  await pending;
  assert.equal(st().runtime[id].loaded, true);
  assert.equal(st().runtime[id].turns[0].status, 'completed');
});

test('a retired initial read cannot publish an error or clear a replacement load', async () => {
  const id = 'initial-replacement';
  const reads = controlledReads<any>();
  impl['api.threadRead'] = async () => ({ thread: { id } });
  impl['api.threadTurns'] = reads.read;
  const old = S.openThread(id);
  S.patchRuntime(id, () => ({ loading: false }));
  const next = S.openThread(id);
  reads.requests[0].reject(new Error('old read failed'));
  await old;
  assert.equal(st().runtime[id].loading, true);
  assert.equal(st().runtime[id].error, null);
  reads.requests[1].resolve({ data: [serverTurn('current')], nextCursor: null });
  await next;
  assert.equal(st().runtime[id].loading, false);
  assert.equal(st().runtime[id].turns[0].id, 'current');
});

test('a new chat whose lease is taken while its first read runs (a fork) still shows its history, as its own', async () => {
  // thread/started for a fork: main holds the new thread, which retires the read's external-writer claims, not the history
  for (const take of ['lease', 'lease-released', 'resume']) {
    const id = `fork-${take}`;
    const reads = controlledReads<any>();
    impl['api.threadRead'] = async () => ({ thread: { id, path: '/rollout' } });
    impl['api.threadTurns'] = reads.read;
    impl['codex.resume'] = async () => ({ locked: false });
    set({ route: { name: 'thread', id } as any });
    const pending = S.openThread(id);
    if (take === 'resume') await S.ensureResumed(id);
    else item({ kind: 'lease', threadId: id, held: true });
    // an idle release of the chat on screen: main says 'released', and the window follows it on disk from then on
    if (take === 'lease-released') item({ kind: 'lease', threadId: id, held: false, reason: 'released' });
    reads.requests[0].resolve({
      data: [serverTurn('second'), serverTurn('first', { status: 'interrupted', completedAt: null, durationMs: null })],
      nextCursor: null,
    });
    await pending;
    const rt = st().runtime[id];
    assert.deepEqual(
      rt.turns.map((t: any) => [t.id, t.status]),
      [
        ['first', 'interrupted'],
        ['second', 'completed'],
      ],
      take,
    );
    assert.equal(rt.loaded, true, take);
    assert.equal(rt.loading, false, take);
    // the read began before this app took the thread: it can't say another app is running it
    assert.equal(st().elsewhere[id], undefined, take);
    assert.equal(rt.activeTurnId ?? null, null, take);
    // the read itself follows nothing; only the release does
    assert.equal(callsOf('codex.watchRollout').filter(([t]) => t === id).length, take === 'lease-released' ? 1 : 0, take);
  }
});

test('a retired first read publishes nothing; live changes recover, while a source switch or newer open retires it', async () => {
  for (const retire of ['switch', 'stream', 'newer']) {
    for (const reject of [false, true]) {
      const id = `fork-retired-${retire}-${reject}`;
      const reads = controlledReads<any>();
      impl['api.threadRead'] = async () => ({ thread: { id } });
      impl['api.threadTurns'] = reads.read;
      const pending = S.openThread(id);
      item({ kind: 'lease', threadId: id, held: true });
      if (retire === 'switch') set({ segments: { [id]: [{ nativeId: 'replacement', harness: 'claude', start: 0 }] as any } });
      if (retire === 'stream') S.patchRuntime(id, () => ({ turns: [serverTurn('local')] as any }));
      if (retire === 'newer') {
        S.patchRuntime(id, () => ({ loading: false }));
        S.openThread(id);
      }
      const turns = st().runtime[id].turns;
      if (reject) reads.requests[0].reject(new Error('retired read failed'));
      else reads.requests[0].resolve({ data: [serverTurn('disk')], nextCursor: null });
      await flush();
      assert.equal(st().runtime[id].turns, turns, `${retire}/${reject}`);
      if (retire === 'stream') reads.requests[1].resolve({ data: [serverTurn('local')], nextCursor: null });
      await pending;
      assert.equal(st().runtime[id].loaded, retire === 'stream', `${retire}/${reject}`);
      assert.deepEqual(
        st().runtime[id].turns.map((t: any) => t.id),
        turns.map((t: any) => t.id),
        `${retire}/${reject}`,
      );
      assert.equal(st().runtime[id].error, null, `${retire}/${reject}`);
    }
  }
});

test('a first read that fails after this app took the chat says so', async () => {
  const id = 'fork-failed';
  const reads = controlledReads<any>();
  impl['api.threadRead'] = async () => ({ thread: { id } });
  impl['api.threadTurns'] = reads.read;
  const pending = S.openThread(id);
  item({ kind: 'lease', threadId: id, held: true });
  reads.requests[0].reject(new Error('read failed'));
  await pending;
  assert.equal(st().runtime[id].loaded, true);
  assert.equal(st().runtime[id].loading, false);
  assert.equal(st().runtime[id].error, 'read failed');
});

test('an initial read rechecks ownership after the main session snapshot as well as the native reply', async () => {
  const id = 'initial-session-boundary';
  const snapshots = controlledReads<any>();
  let reads = 0;
  const local = serverTurn('local');
  impl['api.threadRead'] = async () => ({ thread: { id } });
  impl['api.threadTurns'] = async () => ({
    data: [++reads === 1 ? serverTurn('external', { status: 'inProgress' }) : local],
    nextCursor: null,
  });
  impl['session.snapshot'] = snapshots.read;
  const pending = S.openThread(id);
  await flush();
  S.patchRuntime(id, () => ({ turns: [local] }));
  snapshots.requests[0].resolve({ ...sessions.sessionOf(id), rev: 1 });
  await pending;
  assert.equal(st().runtime[id].turns[0], local);
  assert.equal(st().elsewhere[id], undefined);
  assert.equal(st().runtime[id].loading, false);
  assert.equal(st().runtime[id].loaded, true);
  assert.equal(reads, 2);
});

test('opening a chat while new items arrive still loads its earlier conversation without another navigation', async () => {
  const id = 'initial-history-live-tail';
  const reads = controlledReads<any>();
  const message = (id: string, text: string) => ({ type: 'userMessage', id, content: [{ type: 'text', text }] });
  const older = serverTurn('older', {
    status: 'interrupted',
    items: [
      message('old-prompt', 'The earlier user message'),
      { type: 'agentMessage', id: 'old-update', text: 'The earlier assistant update', phase: 'commentary' },
      { type: 'commandExecution', id: 'old-tool', status: 'completed', command: 'Inspect evidence', aggregatedOutput: 'Saved evidence' },
    ],
  });
  const current = serverTurn('current', {
    status: 'inProgress',
    items: [
      message('current-prompt', 'Continue this conversation'),
      { type: 'agentMessage', id: 'tail', text: 'The current streamed reply' },
    ],
  });
  let calls = 0;
  impl['api.threadRead'] = async () => ({ thread: { id, status: { type: 'active' } } });
  impl['api.threadTurns'] = () => (++calls === 1 ? reads.read() : Promise.resolve({ data: [current, older], nextCursor: null }));
  const opening = S.openThread(id);
  item({ kind: 'notification', method: 'turn/started', params: { threadId: id, turn: current } });
  item({
    kind: 'notification',
    method: 'item/completed',
    params: { threadId: id, turnId: 'current', item: current.items[1] },
  });
  reads.requests[0].resolve({ data: [current, older], nextCursor: null });
  await opening;
  await flush();
  mock.timers.tick(1000);
  await flush();
  assert.equal(st().runtime[id].loaded, true, 'a live update cannot leave the initial history silently unloaded');
  assert.deepEqual(
    st().runtime[id].turns.map((t: any) => t.id),
    ['older', 'current'],
  );
  assert.equal(st().runtime[id].turns[0].items[0].content[0].text, 'The earlier user message');
  assert.deepEqual(
    st().runtime[id].turns[0].items.map((i: any) => i.id),
    ['old-prompt', 'old-update', 'old-tool'],
  );
  assert.equal(st().runtime[id].turns[1].items.find((i: any) => i.id === 'tail').text, 'The current streamed reply');
});

test('a queued live delta during the session snapshot retires the stale page before it can overwrite the reply', async () => {
  const id = 'initial-buffered-delta';
  const snapshots = controlledReads<any>();
  const tail = (text: string) => serverTurn('current', { items: [{ type: 'agentMessage', id: 'm', text }] });
  S.patchRuntime(id, () => ({ turns: [tail('Hel')] }));
  let reads = 0;
  impl['api.threadRead'] = async () => ({ thread: { id } });
  impl['api.threadTurns'] = async () => ({ data: [tail(++reads === 1 ? 'Hel' : 'Hello'), serverTurn('older')], nextCursor: null });
  impl['session.snapshot'] = snapshots.read;
  const opening = S.openThread(id);
  await flush();
  item({ kind: 'notification', method: 'item/agentMessage/delta', params: { threadId: id, turnId: 'current', itemId: 'm', delta: 'lo' } });
  assert.equal(st().runtime[id].turns[0].items[0].text, 'Hel', 'the delta is still held for the next frame');
  snapshots.requests[0].resolve({ ...sessions.sessionOf(id), rev: 1 });
  await opening;
  assert.equal(reads, 2);
  assert.deepEqual(
    st().runtime[id].turns.map((t: any) => t.id),
    ['older', 'current'],
  );
  assert.equal(st().runtime[id].turns[1].items[0].text, 'Hello');
});

test('continuous live changes stop initial hydration with Retry, and a later held-chat open really loads history', async () => {
  const id = 'initial-churn';
  let reads = 0;
  impl['api.threadRead'] = async () => ({ thread: { id } });
  impl['api.threadTurns'] = async () => {
    item({ kind: 'notification', method: 'turn/started', params: { threadId: id, turn: serverTurn(`live-${++reads}`) } });
    return { data: [serverTurn('stale')], nextCursor: null };
  };
  item({ kind: 'lease', threadId: id, held: true });
  await S.openThread(id);
  assert.equal(reads, 4);
  assert.equal(st().runtime[id].loaded, false);
  assert.equal(st().runtime[id].loading, false);
  assert.match(st().runtime[id].error, /kept changing/);
  assert.equal(st().runtime[id].errorFromRead, true);
  assert.equal(st().runtime[id].turns.at(-1).id, 'live-4');
  const live = st().runtime[id].turns;
  impl['api.threadTurns'] = async () => ({ data: [...live].reverse().concat(serverTurn('older')), nextCursor: null });
  await S.openThread(id);
  assert.equal(st().runtime[id].loaded, true);
  assert.equal(st().runtime[id].error, null);
  assert.equal(st().runtime[id].turns[0].id, 'older');
  assert.equal(st().runtime[id].turns.at(-1).id, 'live-4');
});

test('source round trips and deletion retire first-read recovery as well as its old publication', async () => {
  for (const retire of ['round-trip', 'delete', 'unload']) {
    for (const boundary of ['page', 'session']) {
      for (const reject of [false, true]) {
        const id = `initial-retire-${retire}-${boundary}-${reject}`;
        const pending = controlledReads<any>();
        let reads = 0;
        impl['api.threadRead'] = async () => ({ thread: { id } });
        impl['api.threadTurns'] = () => {
          reads++;
          return boundary === 'page' ? pending.read() : Promise.resolve({ data: [serverTurn('retired')], nextCursor: null });
        };
        impl['session.snapshot'] = boundary === 'session' ? pending.read : async () => null;
        const opening = S.openThread(id);
        await flush();
        if (retire === 'unload') set({ runtime: {} });
        else if (retire === 'delete')
          deletionVisibility.accept({ chatId: id, nativeKeys: [id], nativeDeleted: true, metadata: 'retained' });
        else {
          set({ segments: { [id]: [{ nativeId: 'elsewhere', harness: 'claude', start: 0 }] as any } });
          set({ segments: { [id]: [{ nativeId: id, harness: 'codex', start: 0 }] as any } });
        }
        if (reject) pending.requests[0].reject(new Error('retired failure'));
        else pending.requests[0].resolve(boundary === 'page' ? { data: [serverTurn('retired')], nextCursor: null } : null);
        await opening;
        assert.equal(reads, 1, `${retire}/${boundary}/${reject}`);
        if (retire === 'unload') {
          assert.equal(st().runtime[id], undefined, 'cleanup cannot recreate an unloaded runtime');
          continue;
        }
        assert.equal(st().runtime[id].turns.length, 0);
        assert.equal(st().runtime[id].loading, false);
        assert.equal(st().runtime[id].error, null);
      }
    }
  }
});

test('an accepted rewind during initial hydration is preserved by a fresh post-rewind history read', async () => {
  const id = 'initial-rewind';
  const reads = controlledReads<any>();
  const keep = serverTurn('keep');
  const removed = serverTurn('removed');
  S.patchRuntime(id, () => ({ turns: [keep, removed] }));
  let count = 0;
  impl['api.threadRead'] = async () => ({ thread: { id } });
  impl['api.threadTurns'] = () => (++count === 1 ? reads.read() : Promise.resolve({ data: [keep], nextCursor: null }));
  impl['codex.leased'] = async () => ({ result: {} });
  const opening = S.openThread(id);
  assert.equal(await S.revertThread(id, 'removed'), true);
  reads.requests[0].resolve({ data: [removed, keep], nextCursor: null });
  await opening;
  assert.equal(count, 2);
  assert.deepEqual(
    st().runtime[id].turns.map((t: any) => t.id),
    ['keep'],
  );
  assert.equal(st().runtime[id].loaded, true);
});

test('a source switch that retires initial hydration opens the new composite source without another navigation', async () => {
  const id = 'initial-source-recovery';
  const reads = controlledReads<any>();
  impl['api.threadRead'] = async () => ({ thread: { id } });
  impl['api.threadTurns'] = reads.read;
  impl['switch.openCompositeThread'] = async () => {
    S.patchRuntime(id, () => ({ loaded: true, turns: [serverTurn('earlier'), serverTurn('new-source')] }));
  };
  const opening = S.openThread(id);
  set({ segments: { [id]: [{ nativeId: 'acp:kimi:replacement', harness: 'acp:kimi', start: 0 }] as any } });
  reads.requests[0].resolve({ data: [serverTurn('obsolete')], nextCursor: null });
  await opening;
  assert.equal(callsOf('switch.openCompositeThread').length, 1);
  assert.deepEqual(
    st().runtime[id].turns.map((t: any) => t.id),
    ['earlier', 'new-source'],
  );
  assert.equal(st().runtime[id].loaded, true);
});

for (const stale of ['disk history', 'read error'])
  test(`a source handoff still hydrates when the previous source retained ${stale}`, async () => {
    const id = `source-handoff-stale-${stale}`;
    S.patchRuntime(id, () => ({
      loaded: true,
      turns: [serverTurn('live')],
      fromDisk: stale === 'disk history',
      errorFromRead: stale === 'read error',
      error: stale === 'read error' ? 'The previous source could not be read' : null,
    }));
    const reads = controlledReads<any>();
    impl['api.threadRead'] = async () => ({ thread: { id } });
    impl['api.threadTurns'] = reads.read;
    impl['switch.openCompositeThread'] = async () => {
      S.patchRuntime(id, () => ({
        loaded: true,
        fromDisk: false,
        errorFromRead: false,
        error: null,
        turns: [serverTurn('earlier'), serverTurn('new-source')],
      }));
    };
    const opening = S.openThread(id);
    set({ segments: { [id]: [{ nativeId: 'claude:new-source', harness: 'claude', start: 0 }] as any } });
    reads.requests[0].resolve({ data: [serverTurn('obsolete')], nextCursor: null });
    await opening;
    assert.equal(callsOf('switch.openCompositeThread').length, 1, 'a retained failure is not successfully loaded history');
    assert.equal(st().runtime[id].error, null);
    assert.deepEqual(
      st().runtime[id].turns.map((t) => t.id),
      ['earlier', 'new-source'],
    );
  });

for (const replacement of ['ready', 'pending', 'unloaded'])
  test(`a source handoff leaves its ${replacement} replacement alone`, async () => {
    const id = `source-handoff-${replacement}`;
    const reads = controlledReads<any>();
    impl['api.threadRead'] = async () => ({ thread: { id } });
    impl['api.threadTurns'] = reads.read;
    const opening = S.openThread(id);
    set({ segments: { [id]: [{ nativeId: 'acp:kimi:new-source', harness: 'acp:kimi', start: 0 }] as any } });
    const current = serverTurn('replacement');
    let finish = () => {};
    if (replacement === 'ready') S.patchRuntime(id, () => ({ loaded: true, turns: [current] }));
    else if (replacement === 'pending') {
      // The replacement uses the same public owner API as every native/composite reader.
      finish = beginHistoryOpen(id).finish;
      S.patchRuntime(id, () => ({ turns: [current] }));
    } else set({ runtime: {} });
    try {
      reads.requests[0].resolve({ data: [serverTurn('obsolete')], nextCursor: null });
      await opening;
      assert.equal(callsOf('switch.openCompositeThread').length, 0);
      if (replacement === 'unloaded') assert.equal(st().runtime[id], undefined);
      else {
        assert.equal(st().runtime[id].turns[0], current);
        assert.equal(st().runtime[id].loading, replacement === 'pending');
        assert.equal(st().runtime[id].loaded, replacement === 'ready');
      }
    } finally {
      finish();
    }
  });

test('source churn during initial opens ends with Retry, while a deleted chat cannot restart a read', async () => {
  const id = 'initial-source-churn';
  S.patchRuntime(id, () => ({ loaded: false }));
  set({ segments: { [id]: [{ nativeId: 'first', harness: 'claude', start: 0 }] as any } });
  let reads = 0;
  impl['switch.openCompositeThread'] = async () => {
    set({ segments: { [id]: [{ nativeId: `changed-${++reads}`, harness: 'claude', start: 0 }] as any } });
  };
  await S.openThread(id);
  assert.equal(reads, 4);
  assert.equal(st().runtime[id].loaded, false);
  assert.match(st().runtime[id].error, /kept switching/);
  const deleted = 'already-deleted-initial';
  deletionVisibility.accept({ chatId: deleted, nativeKeys: [deleted], nativeDeleted: true, metadata: 'retained' });
  const before = callsOf('api.threadTurns').length;
  await S.openThread(deleted);
  assert.equal(callsOf('api.threadTurns').length, before);
  assert.equal(st().runtime[deleted], undefined);
});
