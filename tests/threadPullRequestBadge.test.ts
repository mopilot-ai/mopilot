import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const calls: string[] = [];
const io: unknown[][] = [];
let resolver: (id: string, cwd?: string, fresh?: boolean, version?: string) => Promise<any> = async () => null;
let knownImpl: (...args: unknown[]) => unknown = () => undefined;
let deps: any;
let conn = 'ready';
let runtime: any = {};
let histories: any = {};
let nativeId = 'codex-chat';
let headResult = { ok: true, stdout: 'topic\n' };
installNativeStub({
  peer: { referenceHistory: async () => histories },
  fs: { configRoots: async () => ({ codexHome: '/h/.codex' }), readText: async (p: string) => (io.push(['readText', p]), '{}') },
  git: {
    run: async (cwd: string, args: string[]) => (io.push(['git', cwd, args]), headResult),
    gh: async (cwd: string, args: string[]) => (io.push(['gh', cwd, args]), { ok: true, stdout: '' }),
  },
});
mock.module('../src/session/open.ts', { namedExports: { openLink: (u: string) => calls.push(u) } });
// the real cache of saved replies, loaded under its own URL before the reader is mocked
const realModule = '../src/lib/threadPullRequest.ts?real';
const { savedReplies: realSaved, historyVersion: realVersion, anyChatLoading: realLoading } = await import(realModule);
mock.module('../src/lib/threadPullRequest.ts', {
  namedExports: {
    createPullRequestReader: (d: any) => (
      (deps = d),
      Object.assign((...args: [string, string?, boolean?, string?]) => resolver(...args), {
        known: (...args: unknown[]) => knownImpl(...args),
      })
    ),
    savedReplies: realSaved,
    historyVersion: realVersion,
    anyChatLoading: realLoading,
  },
});
mock.module('../src/harness/adapters/codexApi.ts', {
  namedExports: {
    codexApi: { threadAttachments: async (id: string, cursor: string | null) => (io.push(['attachments', id, cursor]), { data: [] }) },
  },
});
stubStore({
  nativeOf: () => nativeId,
  useStore: Object.assign((fn: any) => fn({ conn, runtime }), { getState: () => ({ home: '/Users/me', runtime }) }),
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { noteOwner } = await import('../src/harness/ownership.ts');
noteOwner('claude-chat', 'claude');
const { ThreadPullRequestBadge } = await import('../src/components/sidebar/ThreadPullRequestBadge.tsx');
const prUrl = 'https://github.com/org/repo/pull/42';
const FIELDS = // what the reader asks `gh pr view` for (src/session/pullRequestReader.ts)
  'url,state,isDraft,title,mergeable,mergeStateStatus,statusCheckRollup,additions,deletions,labels,autoMergeRequest,mergedAt,mergeCommit,headRefOid,reviewRequests';

for (const state of ['open', 'draft', 'merged', 'closed', 'unknown'])
  test(`badge renders ${state} accessibly and opens its PR without navigating the chat`, async () => {
    resolver = async () => ({ url: prUrl, number: 42, state, title: 'Fix sidebar' });
    calls.length = 0;
    let rowClicks = 0,
      rowDoubleClicks = 0;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host as any);
    try {
      await act(async () =>
        root.render(
          createElement(
            'div',
            { onClick: () => rowClicks++, onDoubleClick: () => rowDoubleClicks++ },
            createElement(ThreadPullRequestBadge, { threadId: 'chat', updatedAt: 1 }),
          ),
        ),
      );
      const button = host.querySelector('button')!;
      assert.ok(button);
      assert.equal(button.getAttribute('aria-label'), `PR #42 · ${state === 'unknown' ? 'status unavailable' : state} · Fix sidebar`);
      assert.equal(button.className, `thread-pr-badge ${state}`);
      assert.ok(button.querySelector('svg'));
      await act(async () => button.click());
      button.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }) as any);
      assert.deepEqual(calls, [prUrl]);
      assert.equal(rowClicks, 0);
      assert.equal(rowDoubleClicks, 0);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

test('changing chats drops stale results and focus refreshes the current chat', async () => {
  let finishOld!: (value: any) => void;
  let state = 'open';
  resolver = async (id) =>
    id === 'old'
      ? new Promise((resolve) => {
          finishOld = resolve;
        })
      : { url: prUrl, number: 42, state };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  try {
    await act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: 'old', updatedAt: 1 })));
    assert.equal(host.querySelector('button') === null, true);
    await act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: 'new', updatedAt: 1 })));
    assert.match(host.querySelector('button')?.getAttribute('aria-label') ?? '', /PR #42\b/);
    await act(async () => finishOld({ url: prUrl.replace('42', '99'), number: 99, state: 'closed' }));
    assert.doesNotMatch(host.querySelector('button')?.getAttribute('aria-label') ?? '', /#99/);
    state = 'merged';
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    assert.match(host.querySelector('button')!.getAttribute('aria-label')!, /merged/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('a chat with no attached PR has no badge', async () => {
  resolver = async () => null;
  const host = document.createElement('div');
  const root = createRoot(host as any);
  try {
    await act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: 'chat', updatedAt: 1 })));
    assert.equal(host.innerHTML, '');
  } finally {
    await act(async () => root.unmount());
  }
});

test('the reader reads attachments, desktop state and gh for the chat', async () => {
  io.length = 0;
  await deps.attachments('t1', 'c1');
  assert.equal(await deps.legacy(), '{}');
  await deps.gh('https://github.com/o/r/pull/1');
  assert.deepEqual(io, [
    ['attachments', 't1', 'c1'],
    ['readText', '/h/.codex/.codex-global-state.json'],
    ['gh', '/Users/me', ['pr', 'view', '--json', FIELDS, '--', 'https://github.com/o/r/pull/1']],
  ]);
});

test('busy refreshes coalesce a follow-up, hidden polling skips, and disposed callbacks cannot restart', async () => {
  const { deferred } = await import('./support/async-scenarios.ts');
  mock.timers.enable({ apis: ['setInterval'] });
  const requests: ReturnType<typeof deferred>[] = [];
  resolver = () => {
    const result = deferred();
    requests.push(result);
    return result.promise;
  };
  const host = document.createElement('div');
  const root = createRoot(host as any);
  try {
    await act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: 'chat', updatedAt: 1 })));
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'));
      window.dispatchEvent(new window.Event('focus'));
    });
    assert.equal(requests.length, 1);
    await act(async () => requests[0].resolve({ url: prUrl, number: 42, state: 'open' }));
    assert.equal(requests.length, 2);
    assert.equal(host.querySelector('button'), null, 'superseded snapshot is not published');
    await act(async () => requests[1].resolve({ url: prUrl, number: 42, state: 'merged' }));
    assert.match(host.querySelector('button')!.getAttribute('aria-label')!, /merged/);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await act(async () => mock.timers.tick(60_000));
    assert.equal(requests.length, 2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await act(async () => document.dispatchEvent(new window.Event('visibilitychange') as unknown as Event));
    assert.equal(requests.length, 3);
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    await act(async () => root.unmount());
    await act(async () => requests[2].resolve(null));
    await act(async () => mock.timers.tick(60_000));
    assert.equal(requests.length, 3, 'unmount retires both queued refresh and timer callbacks');
  } finally {
    delete (document as any).visibilityState;
    mock.timers.reset();
  }
});

test('each read tells the performance probe what made it: the inputs that changed, "mount", "again" or "poll" (#2963)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { deferred } = await import('./support/async-scenarios.ts');
  const { startPerfProbe } = await import('../src/session/perf.ts');
  const sent: any[] = [];
  const stopProbe = startPerfProbe({
    store: { getState: () => ({ runtime: {}, route: { name: 'home' } }) as any, subscribe: () => () => {} },
    send: (batch) => sent.push(...batch),
    now: () => 1,
    clock: () => 1,
    raf: () => 1,
    cancelRaf: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    observeLongTasks: () => null,
    visible: () => true,
    focused: () => true,
    onHidden: () => () => {},
  });
  const gate = deferred();
  resolver = async () => (await gate.promise, { url: prUrl, number: 42, state: 'open' });
  const host = document.createElement('div');
  const root = createRoot(host as any);
  const show = (updatedAt: number, cwd = '/a') =>
    act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: 'chat', cwd, updatedAt })));
  try {
    await show(1);
    // the first read is pending: an update starts the new run's own read, and the poll that comes while it is pending asks again
    await show(2);
    await act(async () => t.mock.timers.tick(60_000));
    await act(async () => gate.resolve());
    await show(2, '/b');
    await act(async () => t.mock.timers.tick(60_000));
    stopProbe();
    assert.deepEqual(
      sent.filter((x) => x.kind === 'badgeRead').map((x) => x.trigger),
      ['mount', 'updatedAt', 'again', 'cwd', 'poll'],
    );
  } finally {
    await act(async () => root.unmount());
  }
});

test("a row that mounts again reuses its chat's recent answer and reads nothing; the poll, a changed input and a stale answer still read (#2963)", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { REMOUNT_REUSE_MS } = await import('../src/components/sidebar/ThreadPullRequestBadge.tsx');
  const reads: string[] = [];
  const asked: unknown[][] = [];
  let recent = true;
  const answer = { url: prUrl, number: 42, state: 'open' };
  resolver = async (id, cwd) => (reads.push(`${id}@${cwd ?? ''}`), answer);
  knownImpl = (...args) => (asked.push(args), recent ? answer : undefined);
  const host = document.createElement('div');
  const root = createRoot(host as any);
  const show = (cwd: string) =>
    act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: 'chat', cwd, updatedAt: 5 })));
  try {
    // mounted again with a recent answer: it is shown, nothing is read
    await show('/a');
    assert.deepEqual(reads, []);
    assert.match(host.querySelector('button')?.getAttribute('aria-label') ?? '', /PR #42\b/);
    assert.deepEqual(
      asked.find((a) => a.length === 4),
      ['chat', '/a', JSON.stringify([5, 'codex-chat']), REMOUNT_REUSE_MS],
    );
    // the shared minute poll still reads
    await act(async () => t.mock.timers.tick(60_000));
    assert.deepEqual(reads, ['chat@/a']);
    // another folder is a changed input, not a remount: it reads whatever is known
    await show('/b');
    assert.deepEqual(reads, ['chat@/a', 'chat@/b']);
    await act(async () => root.unmount());
    // a new row with only a stale answer reads
    recent = false;
    const again = createRoot(host as any);
    await act(async () => again.render(createElement(ThreadPullRequestBadge, { threadId: 'chat', cwd: '/b', updatedAt: 5 })));
    assert.deepEqual(reads, ['chat@/a', 'chat@/b', 'chat@/b']);
    await act(async () => again.unmount());
  } finally {
    knownImpl = () => undefined;
  }
});

test('the badge reads again when the chat is updated or Codex reconnects, not on every render', async () => {
  const reads: string[] = [];
  resolver = async (id) => (reads.push(id), { url: prUrl, number: 42, state: 'open' });
  const host = document.createElement('div');
  const root = createRoot(host as any);
  const show = (updatedAt: number) => act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: 'chat', updatedAt })));
  try {
    await show(1);
    await show(1);
    assert.deepEqual(reads, ['chat']);
    await show(2);
    assert.deepEqual(reads, ['chat', 'chat']);
    conn = 'connecting';
    await show(2);
    assert.deepEqual(reads, ['chat', 'chat', 'chat']);
    assert.match(host.querySelector('button')?.getAttribute('aria-label') ?? '', /PR #42\b/);
  } finally {
    conn = 'ready';
    await act(async () => root.unmount());
  }
});

test('branch discovery uses the chat cwd on every harness and native attachments only when supported', async () => {
  for (const id of ['codex-chat', 'claude-chat', 'acp:gemini:chat']) {
    nativeId = id;
    io.length = 0;
    await deps.attachments('stable-chat', null);
    assert.equal(await deps.head('/worktree'), 'topic');
    await deps.gh(null, '/worktree', 'topic');
    assert.deepEqual(io, [
      ...(id === 'codex-chat' ? [['attachments', 'stable-chat', null]] : []),
      ['git', '/worktree', ['symbolic-ref', '--quiet', '--short', 'HEAD']],
      ['gh', '/worktree', ['pr', 'view', '--json', FIELDS]],
    ]);
  }
  nativeId = 'codex-chat';
});

test('cwd and current native-session changes hide old badges and ignore retired reads, including after unmount', async () => {
  const { deferred } = await import('./support/async-scenarios.ts');
  const reads: { args: unknown[]; result: ReturnType<typeof deferred> }[] = [];
  // Capture the real refresh arguments without replacing the operation's ownership or cleanup.
  resolver = (...args) => {
    const result = deferred();
    reads.push({ args, result });
    return result.promise;
  };
  const host = document.createElement('div');
  const root = createRoot(host as any);
  const show = (cwd: string) =>
    act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: 'chat', cwd, updatedAt: 1 })));
  const pr = (state: string) => ({ url: prUrl, number: 42, state });
  try {
    await show('/old');
    assert.deepEqual(reads[0].args, ['chat', '/old', true, JSON.stringify([1, 'codex-chat'])]);
    await act(async () => reads[0].result.resolve(pr('open')));
    assert.match(host.querySelector('button')?.getAttribute('aria-label') ?? '', /PR #42\b/);
    await show('/new');
    assert.equal(host.querySelector('button'), null);
    nativeId = 'claude-chat';
    await show('/new');
    await act(async () => reads[1].result.resolve(pr('closed')));
    assert.equal(host.querySelector('button'), null);
    assert.equal(reads.length, 3, 'retired finally cannot clear the replacement busy state');
    await act(async () => reads[2].result.resolve(pr('merged')));
    assert.match(host.querySelector('button')!.getAttribute('aria-label')!, /merged/);
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    await act(async () => root.unmount());
    await act(async () => reads[3].result.resolve(pr('open')));
    assert.equal(host.innerHTML, '');
  } finally {
    nativeId = 'codex-chat';
  }
});

test('branch resolution does not invent a branch on detached, empty or failed git output', async () => {
  try {
    for (const result of [
      { ok: false, stdout: 'topic' },
      { ok: true, stdout: ' \n' },
    ]) {
      headResult = result;
      assert.equal(await deps.head('/repo'), null);
    }
  } finally {
    headResult = { ok: true, stdout: 'topic\n' };
  }
});

test('Strict Mode setup-cleanup-setup retires the first read while the replacement remains pending', async () => {
  const { deferred } = await import('./support/async-scenarios.ts');
  const { StrictMode } = await import('react');
  const requests: ReturnType<typeof deferred>[] = [];
  resolver = () => {
    const result = deferred();
    requests.push(result);
    return result.promise;
  };
  const host = document.createElement('div');
  const root = createRoot(host as any);
  try {
    await act(async () =>
      root.render(createElement(StrictMode, null, createElement(ThreadPullRequestBadge, { threadId: 'chat', cwd: '/repo', updatedAt: 1 }))),
    );
    assert.equal(requests.length, 2);
    await act(async () => requests[0].resolve({ url: prUrl, number: 42, state: 'open' }));
    assert.equal(host.querySelector('button'), null);
    assert.equal(requests.length, 2);
    await act(async () => requests[1].resolve({ url: prUrl, number: 42, state: 'merged' }));
    assert.match(host.querySelector('button')!.getAttribute('aria-label')!, /merged/);
  } finally {
    await act(async () => root.unmount());
  }
});

test('the response reader tolerates an absent saved history and uses a loaded runtime directly', async () => {
  assert.deepEqual(await deps.responses('missing'), []);
  const turns = [{ id: 'done', status: 'completed', items: [] }];
  histories = { saved: { turns } };
  assert.deepEqual(await deps.responses('saved'), turns);
  runtime = { loaded: { loaded: true, turns } };
  assert.equal(await deps.responses('loaded'), turns);
  runtime = {};
  histories = {};
});

test('the badge shows the state icon, not the number; with several PRs, their count, as Claude Code does (#1581)', async () => {
  const entries = [
    { url: prUrl.replace('42', '45'), number: 45, state: 'open', title: 'Third' },
    { url: prUrl.replace('42', '44'), number: 44, state: 'merged', title: 'Second' },
    { url: prUrl, number: 42, state: 'closed', title: 'First' },
  ];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  try {
    resolver = async () => ({ ...entries[0] });
    await act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: 'one', updatedAt: 1 })));
    const single = host.querySelector('button')!;
    assert.equal(single.textContent, '');
    assert.equal(single.querySelector('.thread-pr-count'), null);
    assert.equal(single.getAttribute('aria-label'), 'PR #45 · open · Third');
    resolver = async () => ({ ...entries[0], entries });
    await act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: 'many', updatedAt: 1 })));
    const many = host.querySelector('button')!;
    assert.equal(many.querySelector('.thread-pr-count')!.textContent, '3');
    assert.doesNotMatch(many.textContent!, /#/);
    assert.equal(many.getAttribute('aria-label'), '3 pull requests · latest PR #45 · open · Third');
    // a chat whose entries hold only itself shows no count
    resolver = async () => ({ ...entries[0], entries: [entries[0]] });
    await act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: 'self', updatedAt: 1 })));
    assert.equal(host.querySelector('.thread-pr-count'), null);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("an unchanged chat's saved replies are read from main once, not on every refresh", async () => {
  const turns = [
    { id: 'done', status: 'completed', items: [{ type: 'agentMessage', text: 'Opened PR #7.' }] },
    { id: 'more', status: 'completed', items: [{ type: 'agentMessage', text: 'Nothing about it.' }] },
  ];
  histories = { kept: { turns } };
  const kept = [{ status: 'completed', items: [turns[0].items[0]] }];
  assert.deepEqual(await deps.responses('kept', '5'), kept);
  histories = {};
  // the next minute's refresh at the same version does not ask main again
  assert.deepEqual(await deps.responses('kept', '5'), kept);
  // the chat changed
  assert.deepEqual(await deps.responses('kept', '6'), []);
});

test("the badge reads the chat's PR with its updatedAt and native session as the history version", async () => {
  const seen: unknown[][] = [];
  resolver = async (...args: unknown[]) => (seen.push(args), null);
  const host = document.createElement('div');
  const root = createRoot(host as any);
  try {
    await act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: 'chat', cwd: '/repo', updatedAt: 42 })));
    assert.deepEqual(seen, [['chat', '/repo', true, JSON.stringify([42, 'codex-chat'])]]);
    // another native session (a switched harness) is another version, though updatedAt did not change
    nativeId = 'codex-other';
    await act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: 'chat', cwd: '/repo', updatedAt: 42 })));
    assert.deepEqual(seen.at(-1), ['chat', '/repo', true, JSON.stringify([42, 'codex-other'])]);
  } finally {
    await act(async () => root.unmount());
    nativeId = 'codex-chat';
  }
});

test('hovering the badge shows a card of every PR, and a single PR gets the same card (#1581)', async (t) => {
  const entries = [
    { url: prUrl.replace('42', '45'), number: 45, state: 'open', title: 'Third', additions: 5, deletions: 1 },
    { url: prUrl.replace('42', '44'), number: 44, state: 'merged', title: 'Second' },
    { url: prUrl, number: 42, state: 'closed', title: 'First' },
  ];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const hover = async () => {
    const anchor = host.querySelector('.tooltip-anchor')!;
    await act(async () => anchor.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }) as any));
    await act(async () => t.mock.timers.tick(450));
    return [...document.querySelectorAll('.tooltip.rich .thread-pr-list-item')];
  };
  const leave = async () => {
    const anchor = host.querySelector('.tooltip-anchor')!;
    await act(async () =>
      anchor.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body as any }) as any),
    );
    await act(async () => t.mock.timers.tick(150));
  };
  try {
    resolver = async () => ({ ...entries[0], entries });
    await act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: 'many', updatedAt: 1 })));
    const rows = await hover();
    assert.deepEqual(
      rows.map((r) => r.querySelector('.thread-pr-list-title')!.textContent),
      ['Third', 'Second', 'First'],
    );
    // a row opens its own PR, not the latest
    calls.length = 0;
    await act(async () => (rows[1] as HTMLElement).click());
    assert.deepEqual(calls, [entries[1].url]);
    await leave();
    assert.equal(document.querySelector('.tooltip.rich'), null);
    resolver = async () => ({ ...entries[1] });
    await act(async () => root.render(createElement(ThreadPullRequestBadge, { threadId: 'one', updatedAt: 1 })));
    const single = await hover();
    assert.deepEqual(
      single.map((r) => r.textContent),
      ['SecondMerged · org/repo #44'],
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
