// src/store/sidebarSnapshot.ts and its wiring in boot: the sidebar's chats from the last run are in the store before any list answers, each list then checks its own rows, and the snapshot is written once the lists have all answered.
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const snap = await import('../src/store/sidebarSnapshot.ts');
const { ownerOf } = await import('../src/harness/ownership.ts');
const st = () => S.useStore.getState();
const row = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  name: null,
  preview: '',
  cwd: '/w/p',
  createdAt: 1,
  updatedAt: 1,
  status: { type: 'idle' },
  turns: [],
  ...o,
});
const threadsOf = (ids: string[], o: Record<string, unknown> = {}) => Object.fromEntries(ids.map((id) => [id, row(id, o)]));
const LOCAL_PROJECT = { id: 'p1', name: 'P', path: '/w/p', source: 'local' };
const writes = () => callsOf('state.write').flatMap(([s]) => (s.sidebarSnapshot ? [s.sidebarSnapshot] : []));
/** The seeded threads the window starts with, as the next run would read them. */
const seedFrom = (ids: string[], o: Record<string, unknown> = {}) =>
  snap.seedThreads({ version: 1, rows: ids.map((id) => ({ ...row(id, o) })) }, () => false)!;

// the writer lives as long as the window: started once
before(async () => {
  bootImpls();
  await S.boot();
  await flush();
  snap.startSnapshotWriter();
});
beforeEach(() => {
  resetState();
  resetAll();
  snap.lists.setState({ pending: [], known: false });
});

test('the snapshot lists the newest chats first, as the lists return them: no turns, a short preview, nothing running', () => {
  const long = 'x'.repeat(500);
  const s = snap.snapshotOf({
    old: row('old', { updatedAt: 5 }) as any,
    fresh: row('fresh', { updatedAt: 9, preview: long, turns: [{ id: 't' }], status: { type: 'active' } }) as any,
    temp: row('temp', { updatedAt: 99, ephemeral: true }) as any,
  });
  assert.equal(s.version, 1);
  assert.deepEqual(
    s.rows.map((r) => r.id),
    ['fresh', 'old'],
  );
  assert.equal(s.rows[0].preview.length, 160);
  assert.deepEqual(s.rows[0].turns, []);
  assert.deepEqual(s.rows[0].status, { type: 'notLoaded' });
  assert.equal(s.rows[0].owner, 'codex');
  // a chat without a preview is saved with an empty one
  assert.equal(snap.snapshotOf({ a: row('a', { preview: undefined }) as any }).rows[0].preview, '');
});

test("MoMo's chats are in no snapshot", () => {
  const s = snap.snapshotOf({ a: row('a') as any, m: row('m') as any }, { m: 'main' } as any);
  assert.deepEqual(
    s.rows.map((r) => r.id),
    ['a'],
  );
});

test('the snapshot keeps the newest chats up to its cap', () => {
  const many = Object.fromEntries(Array.from({ length: snap.MAX_SNAPSHOT_ROWS + 5 }, (_, n) => [`c${n}`, row(`c${n}`, { updatedAt: n })]));
  const s = snap.snapshotOf(many as any);
  assert.equal(s.rows.length, snap.MAX_SNAPSHOT_ROWS);
  assert.equal(s.rows[0].id, `c${snap.MAX_SNAPSHOT_ROWS + 4}`);
});

test('a snapshot that is missing, of another version or not a snapshot seeds nothing', () => {
  for (const raw of [undefined, null, 'x', {}, { version: 2, rows: [] }, { version: 1, rows: 'no' }]) {
    assert.equal(
      snap.seedThreads(raw, () => false),
      null,
    );
  }
  assert.equal(snap.lists.getState().known, false);
});

test('a snapshot seeds its valid rows in order, owner kept, minus skipped, repeated and unreadable ones; the project list is then known', () => {
  const seed = snap.seedThreads(
    {
      version: 1,
      rows: [
        { ...row('claude:s1'), owner: 'claude' },
        row('gone'),
        row('s2', { status: { type: 'active' }, turns: [{ id: 't' }] }),
        row('s2'),
        { id: 'no-cwd' },
        null,
        { ...row('nan'), updatedAt: 'x' },
        { ...row('nan2'), createdAt: undefined },
      ],
    },
    (id) => id === 'gone',
  );
  assert.deepEqual(seed!.threadOrder, ['claude:s1', 's2']);
  assert.deepEqual(seed!.threads.s2.status, { type: 'notLoaded' });
  assert.deepEqual(seed!.threads.s2.turns, []);
  assert.equal(ownerOf('claude:s1'), 'claude');
  assert.equal(snap.lists.getState().known, true);
});

test('a list that answers removes the rows it owns and did not list, after it listed; rows another list owns stay', () => {
  S.useStore.setState(seedFrom(['claude:a', 'claude:b', 'c1']));
  snap.confirmList({ listed: ['claude:a'], owns: (id) => id.startsWith('claude:'), complete: true });
  assert.deepEqual(Object.keys(st().threads).sort(), ['c1', 'claude:a']);
  assert.deepEqual(st().threadOrder.sort(), ['c1', 'claude:a']);
  // a second answer finds nothing left to check
  snap.confirmList({ listed: [], owns: (id) => id.startsWith('claude:'), complete: true });
  assert.deepEqual(Object.keys(st().threads).sort(), ['c1', 'claude:a']);
});

test('a row stays while a window shows it or something changed it since it was seeded; a failed or partial list removes nothing', () => {
  S.useStore.setState({ ...seedFrom(['a', 'b', 'c', 'd']), route: { name: 'thread', id: 'a' } as any });
  // b was renamed since it was seeded: it is live
  S.useStore.setState((s: any) => ({ threads: { ...s.threads, b: { ...s.threads.b, name: 'renamed' } } }));
  // a list that stopped at a page cannot tell a chat is gone
  snap.confirmList({ listed: [], owns: () => true, complete: false });
  assert.equal(Object.keys(st().threads).length, 4);
  snap.confirmList({ listed: ['d'], owns: () => true, complete: true });
  assert.deepEqual(Object.keys(st().threads).sort(), ['a', 'b', 'd']);
});

test('the lists a launch waits for: a project with no chat is loading until a snapshot knew it or every list answered', () => {
  snap.expectLists(['claude', 'codex']);
  snap.expectLists(['claude']);
  assert.deepEqual(snap.lists.getState().pending, ['claude', 'codex']);
  snap.settleList('claude');
  snap.settleList('claude');
  assert.deepEqual(snap.lists.getState().pending, ['codex']);
  snap.settleList('codex');
  assert.deepEqual(snap.lists.getState().pending, []);
});

test('the snapshot is written after its changes settle, once the lists answered, and only when it changed', () => {
  snap.expectLists(['claude']);
  S.useStore.setState({ threads: threadsOf(['w1']) as any });
  mock.timers.tick(snap.WRITE_DELAY_MS);
  // a launch still waiting on a list keeps the older snapshot
  assert.equal(writes().length, 0);
  snap.settleList('claude');
  mock.timers.tick(snap.WRITE_DELAY_MS);
  assert.equal(writes().length, 1);
  assert.deepEqual(
    writes()[0].rows.map((r: any) => r.id),
    ['w1'],
  );
  // the same chats again: nothing to write
  S.useStore.setState({ threads: threadsOf(['w1']) as any });
  mock.timers.tick(snap.WRITE_DELAY_MS);
  assert.equal(writes().length, 1);
  // closing the window writes what changed without waiting
  S.useStore.setState({ threads: threadsOf(['w1', 'w2']) as any });
  (globalThis as any).window.dispatchEvent(new Event('pagehide'));
  assert.equal(writes().length, 2);
  mock.timers.tick(snap.WRITE_DELAY_MS);
  assert.equal(writes().length, 2);
});

test('a snapshot that could not be saved is written again at the next change', async () => {
  impl['state.write'] = async () => {
    throw new Error('disk full');
  };
  S.useStore.setState({ threads: threadsOf(['f1']) as any });
  snap.flushSnapshot();
  await flush();
  impl['state.write'] = async () => undefined;
  snap.flushSnapshot();
  assert.equal(writes().length, 2);
});

test('boot draws the saved chats before any list answers, and checks the basic-tier rows against their list', async () => {
  resetAll();
  bootImpls({
    'state.read': async () => ({
      sidebarSnapshot: { version: 1, rows: [{ ...row('claude:s1'), owner: 'claude' }, row('acp:kimi:1'), row('acp:kimi:gone'), row('c9')] },
    }),
    'projects.list': async () => ({ projects: [LOCAL_PROJECT] }),
    'projects.importCodex': async () => ({ projects: [LOCAL_PROJECT] }),
    'acp.list': async () => [{ id: 'acp:kimi:1' }],
  });
  const seen: string[][] = [];
  const stop = S.useStore.subscribe((s: any, prev: any) => {
    if (s.threads !== prev.threads) seen.push(Object.keys(s.threads));
  });
  await S.boot();
  await flush();
  stop();
  assert.deepEqual(seen[0].sort(), ['acp:kimi:1', 'acp:kimi:gone', 'c9', 'claude:s1']);
  assert.deepEqual(
    st().savedProjects.map((p: any) => p.id),
    ['p1'],
  );
  assert.deepEqual(
    st().savedProjects.map((p: any) => p.id),
    ['p1'],
  );
  assert.equal(callsOf('claude.loadClaudeThreads').length, 1);
  // each list checked its own rows: the basic-tier list kept one and dropped one, Codex's (empty) list dropped its chat, and
  // Claude's loader (stubbed here) has not answered, so its row waits
  assert.deepEqual(Object.keys(st().threads).sort(), ['acp:kimi:1', 'claude:s1']);
  assert.deepEqual(snap.lists.getState().pending, ['claude']);
});

test('boot goes on when the projects, the Claude list or the basic-tier list cannot be read', async () => {
  resetAll();
  bootImpls({
    'projects.list': async () => {
      throw new Error('no projects');
    },
    'acp.list': async () => {
      throw new Error('no list');
    },
  });
  impl['claude.loadClaudeThreads'] = async () => {
    throw new Error('no claude list');
  };
  await S.boot();
  await flush();
  assert.deepEqual(st().savedProjects, []);
});

test("Codex's first page removes only what it can tell is gone: a page with more behind it keeps the rows it did not list", async () => {
  S.useStore.setState(seedFrom(['x1', 'x2']));
  snap.expectLists(['codex']);
  impl['api.threadList'] = async () => ({ data: [row('x1')], nextCursor: '100' });
  await S.loadThreads();
  assert.deepEqual(Object.keys(st().threads).sort(), ['x1', 'x2']);
  assert.deepEqual(snap.lists.getState().pending, []);
  // a next page answers for its own chats only
  snap.expectLists(['codex']);
  impl['api.threadList'] = async () => ({ data: [row('x3')], nextCursor: null });
  await S.loadThreads(true);
  assert.deepEqual(Object.keys(st().threads).sort(), ['x1', 'x2', 'x3']);
  assert.deepEqual(snap.lists.getState().pending, ['codex']);
  // the whole history listed: the chat it no longer has goes
  impl['api.threadList'] = async () => ({ data: [row('x1')], nextCursor: null });
  await S.loadThreads();
  assert.deepEqual(Object.keys(st().threads).sort(), ['x1', 'x3']);
});

test('a Codex that cannot start stops the launch waiting for its list', async () => {
  snap.expectLists(['codex']);
  impl['codex.start'] = async () => {
    throw new Error('no codex');
  };
  await S.connect();
  assert.deepEqual(snap.lists.getState().pending, []);
});

test('a launch that leaves Codex idle does not wait for its list', async () => {
  resetAll();
  bootImpls({ 'state.read': async () => ({ prefs: { defaultHarness: 'claude' } }) });
  await S.boot();
  await flush();
  assert.equal(st().conn, 'idle');
  assert.deepEqual(snap.lists.getState().pending, ['claude']);
});

test("Claude Code's list confirms the rows it lists, removes the seeded ones it no longer has, and ends the wait", async () => {
  const { loadClaudeThreads } = await import('../src/session/harness/claude/threads.ts');
  // the rows were seeded with their owners; 'other' belongs to another harness's list
  const rows = [row('claude:k1', { owner: 'claude' }), row('claude:k2', { owner: 'claude' }), row('other', { owner: 'codex' })];
  S.useStore.setState(snap.seedThreads({ version: 1, rows }, () => false)!);
  snap.expectLists(['claude']);
  impl['claude.list'] = async () => [{ sessionId: 'k1', lastModified: 5000, cwd: '/w/p' }];
  await loadClaudeThreads();
  assert.deepEqual(Object.keys(st().threads).sort(), ['claude:k1', 'other']);
  assert.deepEqual(snap.lists.getState().pending, []);
  // a list that fails removes nothing and still ends the wait
  snap.expectLists(['claude']);
  impl['claude.list'] = async () => {
    throw new Error('unreadable');
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await loadClaudeThreads();
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(Object.keys(st().threads).sort(), ['claude:k1', 'other']);
  assert.deepEqual(snap.lists.getState().pending, []);
});

test("Claude Code's list prunes nothing when a later page failed, or when it is empty before the login is read; an empty list after it prunes", async () => {
  const { loadClaudeThreads } = await import('../src/session/harness/claude/threads.ts');
  const { noteOwner } = await import('../src/harness/ownership.ts');
  const seedClaude = () => {
    const rows = ['claude:m1', 'claude:m2'].map((id) => row(id, { owner: 'claude' }));
    S.useStore.setState(snap.seedThreads({ version: 1, rows }, () => false)!);
    for (const r of rows) noteOwner(r.id, 'claude');
  };
  const page = (n: number) => Array.from({ length: n }, (_, i) => ({ sessionId: `m${i + 1}`, lastModified: 1000 + i, cwd: '/w/p' }));
  // the second page fails: what the first page did not list may still exist
  seedClaude();
  let calls = 0;
  impl['claude.list'] = async () => {
    if (++calls === 2) throw new Error('page 2');
    return calls === 1
      ? [...page(1), ...Array.from({ length: 199 }, (_, i) => ({ sessionId: `z${i}`, lastModified: 1, cwd: '/w/p' }))]
      : [];
  };
  await loadClaudeThreads();
  assert.ok(st().threads['claude:m2']);
  // empty while the login is still being read (as a signed-out CLI answers)
  seedClaude();
  S.useStore.setState((s: any) => ({ claude: { ...s.claude, status: { ...s.claude.status, state: 'detecting' } } }));
  impl['claude.list'] = async () => [];
  await loadClaudeThreads();
  assert.ok(st().threads['claude:m1'] && st().threads['claude:m2']);
  // empty after the login is read: the chats really are gone
  S.useStore.setState((s: any) => ({ claude: { ...s.claude, status: { ...s.claude.status, state: 'ready' } } }));
  seedClaude();
  await loadClaudeThreads();
  assert.equal(st().threads['claude:m1'], undefined);
});
