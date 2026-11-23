// A Codex thread's folder after MoPilot restarts (CodexAdapter.folderOf): a thread this app-server run hasn't loaded is
// read from its rollout's metadata without loading it (no writer lock), and the read never outlives a newer answer.
import { test, assert, thread, setup, settle } from './support/codex-adapter/fixture.ts';

test('a thread untouched since the restart reads its folder from thread/read, without resuming it or taking a lease', async () => {
  const { a, server, events } = setup({ 'thread/read': (p) => ({ thread: thread(p.threadId, { cwd: '/repo/worktree' }) }) });
  assert.equal(a.cwdOf('t1'), null, 'this run has heard nothing about it');
  assert.equal(await a.folderOf('t1'), '/repo/worktree');
  const reads = server.sent.filter((m) => m.method === 'thread/read');
  assert.deepEqual(
    reads.map((m) => m.params),
    [{ threadId: 't1' }],
    'metadata only: no turns',
  );
  assert.ok(!server.methods().includes('thread/resume'), 'the thread is not loaded');
  assert.equal(a.leases.has('t1'), false);
  assert.equal(events.filter((x) => x.e.kind === 'lease').length, 0);
  // remembered: the next lookup asks nothing
  assert.equal(await a.folderOf('t1'), '/repo/worktree');
  assert.equal(server.methods().filter((m) => m === 'thread/read').length, 1);
  assert.equal(a.cwdOf('t1'), '/repo/worktree');
});

test('a thread this run already knows answers from memory', async () => {
  const { a, server } = setup();
  a.hold('t2', thread('t2', { cwd: '/held' }));
  assert.equal(await a.folderOf('t2'), '/held');
  assert.ok(!server.methods().includes('thread/read'));
});

test('a resume that answers while the read is out keeps its newer metadata', async () => {
  const held: (() => void)[] = [];
  const { a, server } = setup({ 'thread/read': (p) => ({ thread: thread(p.threadId, { cwd: '/old', name: 'stale' }) }) });
  const sent = server.send.bind(server);
  // hold the read's answer until the resume has landed
  server.send = (m: any) => {
    if (m.method === 'thread/read') return void held.push(() => sent(m));
    sent(m);
  };
  const folder = a.folderOf('t3');
  await settle();
  a.hold('t3', thread('t3', { cwd: '/new', name: 'fresh' }));
  assert.equal(held.length, 1);
  held[0]();
  assert.equal(await folder, '/new');
  assert.equal(a.meta.get('t3').name, 'fresh');
});

test("a thread the app-server can't read, or one with no folder, reads unknown", async () => {
  const { a } = setup({
    'thread/read': (p) => {
      if (p.threadId === 'gone') throw new Error('thread not found');
      return p.threadId === 'bare' ? {} : { thread: thread(p.threadId, { cwd: null }) };
    },
  });
  assert.equal(await a.folderOf('gone'), null);
  assert.equal(await a.folderOf('bare'), null);
  assert.equal(await a.folderOf('nocwd'), null);
  assert.equal(a.meta.has('gone'), false);
  assert.equal(a.meta.has('bare'), false);
});
