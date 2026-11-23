// Create and merge through the real PR monitor IPC on every harness: binding, stacked base, window-only access, overlap and retirement.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { prMonitorFixture } from './support/pr-monitor-fixture.ts';
import { deferred } from './support/async-scenarios.ts';
import { selectSegment } from './support/controller/fixture.ts';

const require = createRequire(import.meta.url);
const gitPlatform = require('../electron/platform/git.cjs');
const url = 'https://github.com/o/r/pull/1';
const head = '0123456789abcdef0123456789abcdef01234567';
const moved = 'fedcba9876543210fedcba9876543210fedcba98';

/** One repository behind the fixture's run: a branch, its commits, and the pull request gh creates, reads and merges. */
function world(f: ReturnType<typeof prMonitorFixture>) {
  const w = {
    calls: [] as string[][],
    branch: 'feature',
    prHead: 'feature',
    head,
    state: 'OPEN',
    mergeStateStatus: 'CLEAN',
    ancestor: true,
    create: null as null | ((args: string[]) => any),
    merge: null as null | ((args: string[]) => any),
    push: null as null | (() => any),
  };
  const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });
  f.deps.github = async (cmd: string, args: string[], opts: any) => {
    w.calls.push([cmd, ...args]);
    assert.equal(opts.cwd, '/work');
    if (cmd === 'git') {
      if (args[0] === 'rev-parse') return ok(`${w.branch}\n`);
      if (args[0] === 'merge-base') return { ...ok(), ok: w.ancestor };
      if (args[0] === 'log') return ok('Add merge\x1fWhy it matters\x1e\n');
      if (args[0] === 'push') return (await w.push?.()) ?? ok();
      return ok('origin/main\n');
    }
    if (args[0] === 'repo')
      return ok(
        JSON.stringify({
          defaultBranchRef: { name: 'main' },
          squashMergeAllowed: true,
          mergeCommitAllowed: false,
          rebaseMergeAllowed: false,
          viewerDefaultMergeMethod: 'SQUASH',
        }),
      );
    if (args[1] === 'create') return (await w.create?.(args)) ?? ok(`${url}\n`);
    if (args[1] === 'merge') {
      const answer = await w.merge?.(args);
      if (answer) return answer;
      w.state = 'MERGED';
      return ok();
    }
    return ok(
      JSON.stringify({
        url,
        title: 'Add merge',
        state: w.state,
        headRefOid: w.head,
        headRefName: w.prHead,
        baseRefName: 'main',
        mergeable: 'MERGEABLE',
        mergeStateStatus: w.mergeStateStatus,
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit-tests', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      }),
    );
  };
  return w;
}
const call = (f: ReturnType<typeof prMonitorFixture>, name: string, ...args: any[]) => f.handlers.get(name)({ sender: f.sender }, ...args);
const input = { title: 'Add merge', body: 'Why it matters', base: 'main', branch: 'feature' };
const quiet = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

test('a click creates the pull request and binds it to the chat’s monitor, the same on every harness', async () => {
  const f = prMonitorFixture();
  const w = world(f);
  const info = mock.method(gitPlatform, 'worktreeInfo', () => ({ sourceBranch: 'release' }));
  try {
    for (const family of ['codex', 'claude', 'acp:qwen']) {
      const id = `create-${family}`;
      selectSegment(f.controller, f.chats, id, [[family, `native-${family}`]]);
      const draft = await call(f, 'prMonitor:createDraft', id);
      assert.deepEqual(draft, {
        status: 'draft',
        branch: 'feature',
        base: 'release',
        stacked: false,
        title: 'Add merge',
        body: 'Why it matters',
        commits: 1,
      });
      assert.equal(f.monitor.snapshot(id), null);
      assert.deepEqual(await call(f, 'prMonitor:create', id, input), { status: 'created', url, bound: true });
      // the existing monitor now tracks it and reads it, with no agent turn started
      await f.monitor.refresh(id);
      assert.equal(f.monitor.snapshot(id)!.url, url);
      assert.equal(f.monitor.snapshot(id)!.pr.title, 'Add merge');
      assert.equal(f.execs.length, 0);
    }
    assert.equal(info.mock.calls[0].arguments[0], '/work');
    assert.equal(w.calls.filter((c) => c[1] === 'push').length, 3);
    assert.deepEqual(
      w.calls.find((c) => c[2] === 'create'),
      ['gh', 'pr', 'create', '--title', 'Add merge', '--body', 'Why it matters', '--head', 'feature', '--base', 'main'],
    );
  } finally {
    info.mock.restore();
    f.cleanup();
  }
});

test('a linked session’s draft stacks on the open pull request of the chat that started it', async () => {
  const f = prMonitorFixture();
  const w = world(f);
  w.prHead = 'parent-branch';
  try {
    selectSegment(f.controller, f.chats, 'parent', [['claude', 'p']]);
    selectSegment(f.controller, f.chats, 'child', [['codex', 'c']]);
    const children: Record<string, any> = { child: { parentId: 'parent' } };
    f.live.orchestrator = { journal: { child: (id: string) => children[id] ?? null } };
    // the parent tracks nothing yet: the worktree's own base (here unmanaged: the remote's default)
    assert.equal((await call(f, 'prMonitor:createDraft', 'child')).base, 'main');
    f.monitor.configure('parent', { url });
    await f.monitor.refresh('parent');
    const stacked = await call(f, 'prMonitor:createDraft', 'child');
    assert.equal(stacked.base, 'parent-branch');
    assert.equal(stacked.stacked, true);
    // the parent's branch is not under this chat's commits, its PR ended, or the link was detached: not stacked
    w.ancestor = false;
    assert.equal((await call(f, 'prMonitor:createDraft', 'child')).stacked, false);
    w.ancestor = true;
    children.child = { parentId: 'parent', detached: true };
    assert.equal((await call(f, 'prMonitor:createDraft', 'child')).stacked, false);
    children.child = { parentId: 'parent' };
    w.state = 'MERGED';
    await f.monitor.refresh('parent', true);
    assert.equal((await call(f, 'prMonitor:createDraft', 'child')).stacked, false);
    // the chat that started others is not itself stacked
    assert.equal((await call(f, 'prMonitor:createDraft', 'parent')).stacked, false);
  } finally {
    f.cleanup();
  }
});

test('refusals and the web fallback bind nothing; an existing pull request is attached', async () => {
  const f = prMonitorFixture();
  const w = world(f);
  try {
    selectSegment(f.controller, f.chats, 'chat', [['claude', 'native']]);
    w.push = () => ({ ok: false, stdout: '', stderr: '! [rejected] (non-fast-forward)' });
    assert.equal((await call(f, 'prMonitor:create', 'chat', input)).reason, 'push_failed');
    w.push = null;
    w.create = (args) =>
      args.includes('--web') ? { ok: true, stdout: '', stderr: '' } : { ok: false, stdout: '', stderr: 'a template is required' };
    assert.deepEqual(await call(f, 'prMonitor:create', 'chat', input), { status: 'web', why: 'a template is required' });
    assert.equal(f.monitor.snapshot('chat'), null);
    w.create = () => ({ ok: false, stdout: '', stderr: `a pull request for branch "feature" into branch "main" already exists:\n${url}` });
    // the monitor's store cannot be written: the pull request is real, so its link is returned instead of an error
    const save = f.monitor.o.save;
    f.monitor.o.save = () => {
      throw new Error('disk full');
    };
    assert.deepEqual(await call(f, 'prMonitor:create', 'chat', input), { status: 'exists', url, bound: false });
    assert.equal(f.monitor.snapshot('chat'), null);
    f.monitor.o.save = save;
    assert.deepEqual(await call(f, 'prMonitor:create', 'chat', input), { status: 'exists', url, bound: true });
    assert.equal(f.monitor.snapshot('chat')!.url, url);
  } finally {
    f.cleanup();
  }
});

test('a merge needs the window’s click: it merges the tracked head, refreshes the rows, and no agent tool reaches it', async () => {
  const f = prMonitorFixture();
  const w = world(f);
  try {
    for (const family of ['codex', 'claude', 'acp:qwen']) {
      const id = `merge-${family}`;
      selectSegment(f.controller, f.chats, id, [[family, `native-${family}`]]);
      f.monitor.configure(id, { url });
      w.state = 'OPEN';
      assert.deepEqual(await call(f, 'prMonitor:merge', id, url, head), { status: 'merged', method: 'SQUASH' });
      assert.deepEqual(
        w.calls.findLast((c) => c[2] === 'merge'),
        ['gh', 'pr', 'merge', url, '--match-head-commit', head, '--squash'],
      );
      await f.monitor.refresh(id);
      assert.equal(f.monitor.snapshot(id)!.pr.state, 'MERGED');
      assert.equal(f.execs.length, 0);
    }
    // the agent's whole PR surface: reading, settings and stacking. Nothing creates or merges.
    assert.deepEqual([...f.tools.keys()].sort(), ['get_pr_monitor', 'get_pr_stack_candidates', 'set_pr_monitor', 'stack_pull_request']);
    for (const name of ['prMonitor:createDraft', 'prMonitor:create', 'prMonitor:merge'])
      assert.throws(() => f.handlers.get(name)({ sender: { isDestroyed: () => false } }, 'merge-codex', url, head), /Unknown app window/);
  } finally {
    f.cleanup();
  }
});

test('a head that moved, a blocked pull request and a signed-out gh are refused and the rows show GitHub’s current answer', async () => {
  const f = prMonitorFixture();
  const w = world(f);
  try {
    selectSegment(f.controller, f.chats, 'chat', [['codex', 'native']]);
    f.monitor.configure('chat', { url });
    await f.monitor.refresh('chat');
    // new commits were pushed after the row was drawn
    w.head = moved;
    assert.equal((await call(f, 'prMonitor:merge', 'chat', url, head)).reason, 'head_moved');
    await f.monitor.refresh('chat');
    assert.equal(f.monitor.snapshot('chat')!.pr.head, moved);
    // the push lands between main's read and its write: GitHub's own head check refuses
    w.merge = () => ({ ok: false, stdout: '', stderr: 'GraphQL: Head branch was modified. Review and try the merge again.' });
    assert.equal((await call(f, 'prMonitor:merge', 'chat', url, moved)).reason, 'head_moved');
    w.merge = null;
    w.mergeStateStatus = 'BLOCKED';
    assert.equal((await call(f, 'prMonitor:merge', 'chat', url, moved)).reason, 'protected');
    await f.monitor.refresh('chat');
    assert.equal(f.monitor.snapshot('chat')!.pr.mergeState, 'BLOCKED');
    const run = f.deps.github;
    f.deps.github = async () => ({ ok: false, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' });
    assert.equal((await call(f, 'prMonitor:merge', 'chat', url, moved)).reason, 'gh_auth');
    await f.monitor.refresh('chat');
    assert.match(f.monitor.snapshot('chat')!.error, /gh auth login/);
    f.deps.github = run;
    assert.equal(w.calls.filter((c) => c[2] === 'merge').length, 1);
  } finally {
    f.cleanup();
  }
});

test('one action per chat at a time; another chat is not held up', async () => {
  const f = prMonitorFixture();
  const w = world(f);
  try {
    for (const id of ['a', 'b']) {
      selectSegment(f.controller, f.chats, id, [['claude', id]]);
      f.monitor.configure(id, { url });
    }
    await quiet();
    const push = deferred<any>();
    w.push = () => push.promise;
    const first = call(f, 'prMonitor:create', 'a', input);
    await quiet();
    // a second click (or a merge) on the same chat waits for the first's answer instead of racing it
    await assert.rejects(call(f, 'prMonitor:create', 'a', input), /still running for this chat/);
    await assert.rejects(call(f, 'prMonitor:merge', 'a', url, head), /still running for this chat/);
    // the slow push holds no GitHub read: another chat merges meanwhile
    assert.equal((await call(f, 'prMonitor:merge', 'b', url, head)).status, 'merged');
    push.resolve({ ok: true, stdout: '', stderr: '' });
    assert.equal((await first).status, 'created');
    // the slot is free again after success and after a thrown failure
    f.live.peerRuntime.projectOf = async () => '';
    await assert.rejects(call(f, 'prMonitor:create', 'a', input), /no working folder/);
    f.live.peerRuntime.projectOf = async () => '/work';
    w.state = 'OPEN';
    assert.equal((await call(f, 'prMonitor:merge', 'a', url, head)).status, 'merged');
  } finally {
    f.cleanup();
  }
});

test('create and merge retire when the chat is rebound, switched, deleted or the app quits while the folder is read', async () => {
  for (const method of ['prMonitor:createDraft', 'prMonitor:create', 'prMonitor:merge'])
    for (const retire of ['binding', 'delete', 'scope', 'dispose']) {
      const f = prMonitorFixture();
      const w = world(f);
      try {
        selectSegment(f.controller, f.chats, 'chat', [['codex', 'first']]);
        f.monitor.configure('chat', { url });
        await quiet();
        w.calls.length = 0;
        const folder = deferred<string>();
        f.live.peerRuntime.projectOf = () => folder.promise;
        const args = method === 'prMonitor:merge' ? [url, head] : [input];
        const task = call(f, method, 'chat', ...args);
        if (retire === 'binding') f.monitor.configure('chat', { url: 'https://github.com/o/r/pull/2' });
        if (retire === 'delete') f.chats.records.delete('chat');
        if (retire === 'scope')
          selectSegment(f.controller, f.chats, 'chat', [
            ['codex', 'first'],
            ['claude', 'second'],
          ]);
        if (retire === 'dispose') f.app.emit('will-quit');
        folder.resolve('/work');
        await assert.rejects(task, /chat or its pull request changed/);
        assert.equal(w.calls.filter((c) => c[1] === 'push' || c[2] === 'create' || c[2] === 'merge').length, 0);
      } finally {
        f.cleanup();
      }
    }
});

test('work accepted before the chat changed is reported, never bound or refreshed into the replacement context', async () => {
  const f = prMonitorFixture();
  const w = world(f);
  try {
    selectSegment(f.controller, f.chats, 'chat', [['claude', 'native']]);
    // the harness is switched while gh creates the pull request: it exists, and this chat's new context does not adopt it
    w.create = () => {
      selectSegment(f.controller, f.chats, 'chat', [
        ['claude', 'native'],
        ['codex', 'next'],
      ]);
      return undefined;
    };
    assert.deepEqual(await call(f, 'prMonitor:create', 'chat', input), { status: 'created', url, bound: false });
    assert.equal(f.monitor.snapshot('chat'), null);
    // the draft's read finished for a chat that has since changed
    w.create = null;
    const log = deferred<any>();
    const run = f.deps.github;
    f.deps.github = (cmd: string, args: string[], opts: any) => (args[0] === 'log' ? log.promise : run(cmd, args, opts));
    const draft = call(f, 'prMonitor:createDraft', 'chat');
    await quiet();
    f.chats.records.delete('chat');
    log.resolve({ ok: true, stdout: '', stderr: '' });
    await assert.rejects(draft, /chat or its pull request changed/);
    f.deps.github = run;
    // a merge GitHub accepted for a chat rebound meanwhile: the answer is returned, the other PR's rows are left alone
    selectSegment(f.controller, f.chats, 'other', [['codex', 'o']]);
    f.monitor.configure('other', { url });
    await quiet();
    const other = 'https://github.com/o/r/pull/2';
    w.merge = () => {
      f.monitor.configure('other', { url: other });
      w.state = 'MERGED';
      return { ok: true, stdout: '', stderr: '' };
    };
    assert.equal((await call(f, 'prMonitor:merge', 'other', url, head)).status, 'merged');
    assert.equal(f.monitor.snapshot('other')!.url, other);
    // unknown chats, and a merge of a pull request the chat does not track, never start
    await assert.rejects(call(f, 'prMonitor:createDraft', 'missing'), /This chat is unavailable/);
    await assert.rejects(call(f, 'prMonitor:merge', 'other', url, head), /chat or its pull request changed/);
  } finally {
    f.cleanup();
  }
});
