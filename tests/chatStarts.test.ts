// New-chat sidebar admission precedes asynchronous folder, worktree and harness preparation on every harness.
import { beforeEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl, resetAll, callsOf, flush } from './support/store-harness.ts';
import { deferred } from './support/async-scenarios.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const { useChatStarts } = await import('../src/lib/chatStarts.ts');
const starts = () => useChatStarts.getState();
const state = () => S.useStore.getState();
const set = S.useStore.setState;

beforeEach(() => {
  resetState();
  resetAll();
  useChatStarts.setState([], true);
  set({
    conn: 'ready',
    home: '/home/me',
    newChatProjectId: 'project',
    savedProjects: [{ id: 'project', codexId: 'native-project', name: 'Project', roots: [{ path: '/repo' }] }],
    newChatWorktree: true,
  });
  impl['fs.readText'] = async () => '';
  impl['codex.startThread'] = async ({ cwd }: any) => ({ thread: { id: 'real-chat', cwd } });
});

test('a submitted chat appears in its project before worktree creation answers', async () => {
  const worktree = deferred();
  impl['git.worktreeAdd'] = () => worktree.promise;
  const starting = S.createChatThread('Fix the login flow');
  try {
    assert.deepEqual(
      starts().map(({ name, cwd, projectId }) => ({ name, cwd, projectId })),
      [{ name: 'Fix the login flow', cwd: '/repo', projectId: 'project' }],
    );
    assert.deepEqual(state().threads, {}, 'a starting entry cannot be sent to a native harness');
  } finally {
    worktree.resolve({ ok: true, path: '/repo/wt', branch: 'task', repo: '/repo', worktree: '/repo/wt' });
    await starting;
  }
  assert.deepEqual(starts(), []);
  assert.ok(state().threads['real-chat']);
});

for (const family of ['codex', 'claude', 'acp:kimi']) {
  test(`${family}: folder preparation shows the submission before the harness can start`, async () => {
    set({
      newChatProjectId: 'none',
      newChatWorktree: false,
      newChatHarnessPick: family,
      claude: { status: { state: 'ready' }, models: [] },
      basicHarnesses: [{ id: 'kimi', state: 'admitted' }],
    });
    const folder = deferred();
    impl['fs.mkdirProjectless'] = () => folder.promise;
    impl['claude.startClaudeThread'] = () => 'claude:real';
    impl['acp.startAcpThread'] = () => 'acp:kimi:real';
    const pending = S.createChatThread('Build something');
    assert.equal(starts().length, 1);
    assert.deepEqual([starts()[0].cwd, starts()[0].projectId], ['', null]);
    set({ route: { name: 'settings' }, newChatProjectId: 'another-project' });
    await flush();
    assert.equal(starts().length, 1, 'navigation does not cancel accepted input');
    assert.equal(
      callsOf('codex.startThread').length + callsOf('claude.startClaudeThread').length + callsOf('acp.startAcpThread').length,
      0,
    );
    folder.resolve({ path: '/tasks/build-something' });
    assert.equal(await pending, family === 'codex' ? 'real-chat' : family === 'claude' ? 'claude:real' : 'acp:kimi:real');
    assert.deepEqual(starts(), []);
  });
}

test('Codex startup and Claude prewarm remain visible while their native boundary is silent', async () => {
  for (const family of ['codex', 'claude']) {
    set({ newChatWorktree: false, newChatHarnessPick: family, claude: { status: { state: 'ready' }, models: [] } });
    const native = deferred();
    impl['session.prewarmTake'] = (o: any) => (o.kind === 'claude' ? native.promise : Promise.resolve(null));
    impl['codex.startThread'] = () => native.promise;
    impl['claude.startClaudeThread'] = () => 'claude:ready';
    const pending = S.createChatThread('Keep the startup visible');
    await flush();
    assert.equal(starts()[0].name, 'Keep the startup visible');
    native.resolve(family === 'codex' ? { thread: { id: 'codex:ready', cwd: '/repo' } } : { sid: 'ready' });
    await pending;
    assert.deepEqual(starts(), []);
  }
});

for (const finishFirst of [0, 1]) {
  for (const failure of [false, true]) {
    test(`independent starts survive ${finishFirst ? 'newer' : 'older'} ${failure ? 'failure' : 'completion'} first`, async () => {
      const work = [deferred(), deferred()];
      let n = 0;
      impl['git.worktreeAdd'] = () => work[n++].promise;
      impl['codex.startThread'] = async ({ cwd }: any) => ({ thread: { id: cwd, cwd } });
      const pending = [S.createChatThread('First submission')];
      const first = starts()[0];
      set({ newChatProjectId: null, newChatCwd: '/other' });
      pending.push(S.createChatThread('Second submission'));
      const second = starts()[0];
      assert.deepEqual(
        starts().map((s) => s.id),
        [second.id, first.id],
      );
      assert.deepEqual([first.projectId, first.cwd, second.projectId, second.cwd], ['project', '/repo', null, '/other']);
      const finish = (i: number) =>
        work[i].resolve({ ok: true, path: `/wt/${i}`, repo: i ? '/other' : '/repo', worktree: `/wt/${i}`, branch: 'task' });
      if (failure) work[finishFirst].reject(new Error('setup refused'));
      else finish(finishFirst);
      assert.equal(await pending[finishFirst], failure ? null : `/wt/${finishFirst}`);
      const remaining = finishFirst ? first : second;
      assert.deepEqual(
        starts().map((s) => s.id),
        [remaining.id],
      );
      finish(1 - finishFirst);
      assert.equal(await pending[1 - finishFirst], `/wt/${1 - finishFirst}`);
      assert.deepEqual(starts(), []);
      assert.equal(state().threads[first.id], undefined);
      assert.equal(state().threads[second.id], undefined);
    });
  }
}

test('failed workspace setup removes its entry and a retry starts normally', async () => {
  impl['git.worktreeAdd'] = async () => {
    throw new Error('permission denied');
  };
  assert.equal(await S.createChatThread('Try again'), null);
  assert.deepEqual(starts(), []);
  assert.match(state().toasts.at(-1).text, /Failed to start chat:.*permission denied/);
  impl['git.worktreeAdd'] = async () => ({ ok: true, path: '/wt', repo: '/repo', worktree: '/wt', branch: 'task' });
  assert.equal(await S.createChatThread('Try again'), 'real-chat');
  assert.deepEqual(starts(), []);
});

test('temporary chat startup never publishes a sidebar entry', async () => {
  set({ newChatTemporary: true, newChatWorktree: false });
  const native = deferred();
  impl['codex.startThread'] = () => native.promise;
  const pending = S.createChatThread('Private prompt');
  await flush();
  assert.deepEqual(starts(), []);
  native.resolve({ thread: { id: 'private', cwd: '/repo', ephemeral: true } });
  assert.equal(await pending, 'private');
  assert.deepEqual(starts(), []);
});

test('remote startup appears while machine readiness is being read and retires on success or refusal', async () => {
  // (the Worktree switch is off: with it on, the machine is asked for the branches first, tests/machineStart.test.ts)
  set({
    newChatWorktree: false,
    newChatProjectId: null,
    newChatCwd: null,
    newChatHost: { id: 'box', name: 'Build box', path: '/remote/repo' },
  });
  for (const failure of [false, true]) {
    const machine = deferred();
    impl['host.machines'] = () => machine.promise;
    impl['acp.startHostAcpThread'] = async () => {
      if (failure) throw new Error('machine unavailable');
      return 'acp:remote:real';
    };
    const pending = S.createChatThread('Remote task');
    assert.deepEqual([starts()[0].cwd, starts()[0].projectId], ['/remote/repo', null]);
    machine.resolve({ machines: [] });
    assert.equal(await pending, failure ? null : 'acp:remote:real');
    assert.deepEqual(starts(), []);
  }
});
