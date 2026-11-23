// Stacking through real PR monitor IPC/tools across harnesses, scope retirement and accepted-write lifetime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prMonitorFixture } from './support/pr-monitor-fixture.ts';
import { registerPrStack } from '../electron/app/ipc/prStack.cjs';
import { Registry } from '../electron/capabilities/contract/registry.cjs';
import { deferred } from './support/async-scenarios.ts';
import { selectSegment } from './support/controller/fixture.ts';
const url = 'https://github.com/o/r/pull/1';

function stackGithub(f: ReturnType<typeof prMonitorFixture>) {
  const parentUrl = 'https://github.com/o/r/pull/2';
  const prs = [
    { url, title: 'Child', state: 'OPEN', headRefName: 'child', baseRefName: 'main', isCrossRepository: false },
    { url: parentUrl, title: 'Parent', state: 'OPEN', headRefName: 'parent', baseRefName: 'main', isCrossRepository: false },
  ];
  const calls: string[][] = [];
  f.deps.github = async (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[1] === 'edit') prs[0].baseRefName = args.at(-1)!;
    const value =
      args[1] === 'list'
        ? prs
        : { ...(prs.find((p) => p.url === args[2]) ?? prs[0]), headRefOid: 'head', mergeable: 'MERGEABLE', statusCheckRollup: [] };
    return { ok: true, stdout: JSON.stringify(value), stderr: '' };
  };
  return { prs, calls, parentUrl };
}

test('stack picker IPC and no-window tools share the same current-harness base changes and refreshed snapshot', async () => {
  const f = prMonitorFixture();
  const gh = stackGithub(f);
  const registry = new Registry();
  for (const tool of f.tools.values()) registry.register(tool);
  try {
    for (const family of ['codex', 'claude', 'acp:qwen']) {
      const id = `stack-${family}`;
      selectSegment(f.controller, f.chats, id, [[family, `native-${family}`]]);
      f.monitor.configure(id, { url });
      gh.prs[0].baseRefName = 'main';
      const ctx = { chatId: id, segmentId: f.controller.ref(id).key };
      const choices = await f.tools.get('get_pr_stack_candidates').handler({ url }, ctx);
      assert.deepEqual(
        choices.map((p: any) => p.url),
        [gh.parentUrl],
      );
      assert.equal((await registry.invoke(id, ctx.segmentId, 'get_pr_stack_candidates', { url })).ok, true);
      const action = await registry.invoke(id, ctx.segmentId, 'stack_pull_request', { url, parentUrl: gh.parentUrl });
      assert.equal(action.ok, true, JSON.stringify(action.error));
      assert.equal(f.monitor.snapshot(id)!.pr.baseRefName, 'parent');
      assert.equal(f.monitor.snapshot(id)!.url, url);
      assert.equal(f.execs.length, 0);
      assert.deepEqual(
        (await f.handlers.get('prMonitor:stackCandidates')({ sender: f.sender }, id, url)).map((p: any) => p.url),
        [gh.parentUrl],
      );
      await f.handlers.get('prMonitor:stack')({ sender: f.sender }, id, url, gh.parentUrl);
    }
    assert.equal(gh.calls.filter((a) => a[1] === 'edit').length, 3);
    for (const name of ['prMonitor:stackCandidates', 'prMonitor:stack']) {
      assert.throws(
        () => f.handlers.get(name)({ sender: { isDestroyed: () => false } }, 'stack-codex', url, gh.parentUrl),
        /Unknown app window/,
      );
    }
    for (const name of ['get_pr_stack_candidates', 'stack_pull_request']) {
      assert.throws(
        () => f.tools.get(name).handler({ url, parentUrl: gh.parentUrl }, { chatId: 'stack-codex', segmentId: 'retired' }),
        /current chat segment/,
      );
    }
    await assert.rejects(
      f.handlers.get('prMonitor:stackCandidates')({ sender: f.sender }, 'stack-codex', gh.parentUrl),
      /tracked pull request changed/,
    );
    f.live.peerRuntime.projectOf = async () => '';
    await assert.rejects(f.handlers.get('prMonitor:stackCandidates')({ sender: f.sender }, 'stack-codex', url), /no working folder/);
  } finally {
    f.cleanup();
  }
});

test('stack actions retire on rebinding, deletion, scope change and disposal while folder lookup waits', async () => {
  for (const method of ['prMonitor:stackCandidates', 'prMonitor:stack'])
    for (const retire of ['binding', 'binding-back', 'delete', 'scope', 'dispose', 'unbound']) {
      const f = prMonitorFixture();
      const gh = stackGithub(f);
      try {
        selectSegment(f.controller, f.chats, 'chat', [['codex', 'first']]);
        if (retire !== 'unbound') f.monitor.configure('chat', { url });
        let release!: (cwd: string) => void;
        f.live.peerRuntime.projectOf = () =>
          new Promise<string>((r) => {
            release = r;
          });
        const task = f.handlers.get(method)({ sender: f.sender }, 'chat', url, gh.parentUrl);
        if (retire === 'binding' || retire === 'binding-back') f.monitor.configure('chat', { url: gh.parentUrl });
        if (retire === 'binding-back') f.monitor.configure('chat', { url });
        if (retire === 'delete') f.chats.records.delete('chat');
        if (retire === 'scope')
          selectSegment(f.controller, f.chats, 'chat', [
            ['codex', 'first'],
            ['claude', 'second'],
          ]);
        if (retire === 'dispose') f.app.emit('will-quit');
        if (release) release('/work');
        await assert.rejects(task, /tracked pull request changed/);
        assert.equal(gh.calls.length, 0);
      } finally {
        f.cleanup();
      }
    }
});

test('an accepted base write survives rebinding without refreshing or changing the replacement PR', async () => {
  const f = prMonitorFixture();
  const gh = stackGithub(f);
  try {
    selectSegment(f.controller, f.chats, 'chat', [['claude', 'native']]);
    f.monitor.configure('chat', { url });
    const run = f.deps.github;
    f.deps.github = async (...args: any[]) => {
      const result = await run(...args);
      if (args[1][1] === 'edit') f.monitor.configure('chat', { url: gh.parentUrl, autoFix: true });
      return result;
    };
    await f.handlers.get('prMonitor:stack')({ sender: f.sender }, 'chat', url, gh.parentUrl);
    assert.equal(gh.prs[0].baseRefName, 'parent');
    assert.equal(f.monitor.snapshot('chat')!.url, gh.parentUrl);
    assert.equal(f.monitor.snapshot('chat')!.autoFix, true);
    assert.equal(f.monitor.snapshot('chat')!.pr, undefined);
  } finally {
    f.cleanup();
  }
});

test('a cancelled registry call cannot refresh or edit a PR after its folder lookup resumes', async () => {
  const f = prMonitorFixture();
  const gh = stackGithub(f);
  const registry = new Registry();
  for (const tool of f.tools.values()) registry.register(tool);
  try {
    selectSegment(f.controller, f.chats, 'chat', [['acp:qwen', 'native']]);
    f.monitor.configure('chat', { url });
    const folder = deferred<string>();
    f.live.peerRuntime.projectOf = () => folder.promise;
    const cancel = new AbortController();
    const task = registry.invoke(
      'chat',
      f.controller.ref('chat').key,
      'stack_pull_request',
      { url, parentUrl: gh.parentUrl },
      { signal: cancel.signal },
    );
    await Promise.resolve();
    cancel.abort();
    assert.equal((await task).ok, false);
    folder.resolve('/work');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(gh.calls.length, 0);
    assert.equal(gh.prs[0].baseRefName, 'main');
  } finally {
    f.cleanup();
  }
});

test('independent Auto-fix settings edits do not retire a pending base change', async () => {
  const f = prMonitorFixture();
  const gh = stackGithub(f);
  try {
    selectSegment(f.controller, f.chats, 'chat', [['codex', 'native']]);
    f.monitor.configure('chat', { url });
    const folder = deferred<string>();
    f.live.peerRuntime.projectOf = () => folder.promise;
    const task = f.handlers.get('prMonitor:stack')({ sender: f.sender }, 'chat', url, gh.parentUrl);
    f.monitor.configure('chat', { autoFix: true });
    folder.resolve('/work');
    await task;
    assert.equal(gh.prs[0].baseRefName, 'parent');
    assert.equal(f.monitor.snapshot('chat')!.autoFix, true);
  } finally {
    f.cleanup();
  }
});

test('retirement after folder capture completes still prevents refreshing a replacement PR', async () => {
  const f = prMonitorFixture();
  const gh = stackGithub(f);
  try {
    selectSegment(f.controller, f.chats, 'chat', [['codex', 'native']]);
    f.monitor.configure('chat', { url });
    const folder = deferred<string>();
    f.live.peerRuntime.projectOf = () => folder.promise;
    const task = f.handlers.get('prMonitor:stack')({ sender: f.sender }, 'chat', url, gh.parentUrl);
    folder.resolve('/work');
    queueMicrotask(() => f.monitor.configure('chat', { url: gh.parentUrl }));
    await assert.rejects(task, /tracked pull request changed/);
    assert.equal(gh.calls.length, 0);
  } finally {
    f.cleanup();
  }
});

test('a queued read cannot publish candidates after the queue hands work to a new owner', async () => {
  const f = prMonitorFixture();
  const gh = stackGithub(f);
  try {
    selectSegment(f.controller, f.chats, 'chat', [['claude', 'native']]);
    f.monitor.configure('chat', { url });
    registerPrStack(
      { handle: (name: string, handler: any) => f.handlers.set(name, handler) },
      {
        live: f.live,
        monitor: f.monitor,
        run: f.deps.run,
        scope: () => 'scope',
        validWindow: () => {},
        github: async (work: () => Promise<any>) => {
          const result = await work();
          f.chats.records.delete('chat');
          return result;
        },
      },
    );
    await assert.rejects(f.handlers.get('prMonitor:stackCandidates')({ sender: f.sender }, 'chat', url), /tracked pull request changed/);
    assert.equal(gh.calls.length, 2);
  } finally {
    f.cleanup();
  }
});
